# Phase 19 - read-only CPU topology probe.
# Purpose: identify P-cores vs E-cores with EVIDENCE (Windows EfficiencyClass),
# so the pinned logical CPU can be chosen deliberately rather than assumed.
# Read-only: calls only GetLogicalProcessorInformationEx and GetProcessAffinityMask.

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Topo {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetLogicalProcessorInformationEx(int relationshipType, IntPtr buffer, ref uint returnedLength);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetProcessAffinityMask(IntPtr hProcess, out UIntPtr processMask, out UIntPtr systemMask);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern UIntPtr SetProcessAffinityMask(IntPtr hProcess, UIntPtr mask);
}
"@

$RelationProcessorCore = 0
$RelationCache = 2

function Get-Records([int]$rel) {
    $len = [uint32]0
    [void][Topo]::GetLogicalProcessorInformationEx($rel, [IntPtr]::Zero, [ref]$len)
    if ($len -eq 0) { return @() }
    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([int]$len)
    $ok = [Topo]::GetLogicalProcessorInformationEx($rel, $buf, [ref]$len)
    if (-not $ok) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf); return @() }
    $out = @()
    $off = 0
    while ($off -lt $len) {
        $relType = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, $off)
        $size    = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, $off + 4)
        if ($size -le 0) { break }
        $payload = $off + 8
        if ($relType -eq $RelationProcessorCore) {
            $flags = [System.Runtime.InteropServices.Marshal]::ReadByte($buf, $payload)
            $eff   = [System.Runtime.InteropServices.Marshal]::ReadByte($buf, $payload + 1)
            $groupCount = [System.Runtime.InteropServices.Marshal]::ReadInt16($buf, $payload + 22)
            $gBase = $payload + 24
            for ($g = 0; $g -lt $groupCount; $g++) {
                $maskOff = $gBase + ($g * 16)
                $mask = [System.Runtime.InteropServices.Marshal]::ReadInt64($buf, $maskOff)
                $grp  = [System.Runtime.InteropServices.Marshal]::ReadInt16($buf, $maskOff + 8)
                $out += [pscustomobject]@{ Mask=$mask; Group=$grp; Flags=$flags; EfficiencyClass=$eff }
            }
        }
        elseif ($relType -eq $RelationCache) {
            $level = [System.Runtime.InteropServices.Marshal]::ReadByte($buf, $payload)
            $cacheSize = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, $payload + 4)
            $cacheType = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, $payload + 8)
            $groupCount = [System.Runtime.InteropServices.Marshal]::ReadInt16($buf, $payload + 30)
            $gBase = $payload + 32
            $masks = @()
            for ($g = 0; $g -lt $groupCount; $g++) {
                $maskOff = $gBase + ($g * 16)
                $masks += [System.Runtime.InteropServices.Marshal]::ReadInt64($buf, $maskOff)
            }
            $out += [pscustomobject]@{ Level=$level; CacheSize=$cacheSize; CacheType=$cacheType; Masks=$masks; Kind='Cache' }
        }
        $off += $size
    }
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
    return $out
}

function MaskToList([Int64]$mask) {
    $l = @()
    for ($i = 0; $i -lt 64; $i++) { if (($mask -shr $i) -band 1) { $l += $i } }
    return $l
}

Write-Output "=== process / system affinity mask ==="
$pm = [UIntPtr]::Zero; $sm = [UIntPtr]::Zero
[void][Topo]::GetProcessAffinityMask([Topo]::GetCurrentProcess(), [ref]$pm, [ref]$sm)
Write-Output ("  current process mask = 0x{0:X}  ({1})" -f [int64]$pm, ((MaskToList ([int64]$pm)) -join ','))
Write-Output ("  system mask          = 0x{0:X}  ({1})" -f [int64]$sm, ((MaskToList ([int64]$sm)) -join ','))
Write-Output ("  logical CPU count    = {0}" -f ([Convert]::ToString([int64]$sm, 2).ToCharArray() | Where-Object {$_ -eq '1'}).Count)

Write-Output ""
Write-Output "=== per-physical-core records (RelationProcessorCore) ==="
$cores = Get-Records $RelationProcessorCore
$i = 0
foreach ($c in $cores) {
    if ($c.PSObject.Properties.Name -contains 'EfficiencyClass') {
        $lpc = MaskToList $c.Mask
        $grade = if ($c.EfficiencyClass -gt 0) { "P-core (higher perf)" } else { "E-core (lower perf)" }
        Write-Output ("  core[{0}] mask=0x{1:X} logicalCPUs=({2}) group={3} efficiencyClass={4}  -> {5}" -f `
            $i, [int64]$c.Mask, ($lpc -join ','), $c.Group, $c.EfficiencyClass, $grade)
        $i++
    }
}

Write-Output ""
Write-Output "=== cache relationships (L1/L2/L3 sharing) ==="
$caches = Get-Records $RelationCache
foreach ($c in $caches) {
    if ($c.Kind -eq 'Cache') {
        $name = switch ($c.Level) { 1 {"L1"} 2 {"L2"} 3 {"L3"} default {"L$($c.Level)"} }
        $t = switch ($c.CacheType) { 0 {"Unified"} 1 {"Instruction"} 2 {"Data"} default {"?"} }
        $all = @()
        foreach ($m in $c.Masks) { $all += MaskToList $m }
        Write-Output ("  {0} {1} size={2} bytes  shared by logicalCPU=({3})" -f $name, $t, $c.CacheSize, ($all -join ','))
    }
}
