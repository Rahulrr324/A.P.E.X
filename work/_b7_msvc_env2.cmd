@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >/dev/null 2>&1
"C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" -G Ninja -DCMAKE_TOOLCHAIN_FILE=E:/My^ Local^ AI/work/b7_diag_20261011_paired_capture/phase15_msvc/toolchain_msvc14_29.cmake -DCMAKE_BUILD_TYPE=Release -S "E:\My Local AI\stark" -B "E:\My Local AI\stark\build-b7diag-msvc-20261014"
echo CONFIGURE_RC=%errorlevel%
