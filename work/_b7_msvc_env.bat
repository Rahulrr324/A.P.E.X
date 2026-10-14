@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >/dev/null
cl 2>&1 | findstr /C:"Version"
cmake --version 2>/dev/null | findstr /C:"version"
