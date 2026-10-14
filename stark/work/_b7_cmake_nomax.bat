@echo off
call C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat
C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe -G Visual Studio 16 2019 -A x64 -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=/D NOMINMAX -S E:\My Local AI\stark -B E:\My Local AI\stark\build-b7diag-msvc-vs2019-nomax
