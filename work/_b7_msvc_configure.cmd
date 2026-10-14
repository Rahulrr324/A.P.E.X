@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >/dev/null 2>&1
set "CMAKE=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "NINJA=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
set "CL=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\cl.exe"
rmdir /s /q "E:\My Local AI\stark\build-b7diag-msvc-20261014" 2>/dev/null
"%CMAKE%" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MAKE_PROGRAM="%NINJA%" -DCMAKE_C_COMPILER="%CL%" -DCMAKE_CXX_COMPILER="%CL%" -S "E:\My Local AI\stark" -B "E:\My Local AI\stark\build-b7diag-msvc-20261014"
echo CONFIGURE_RC=%errorlevel%
