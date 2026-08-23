@echo off
setlocal

if "%WIKI_KIT_PACKAGE%"=="" set "WIKI_KIT_PACKAGE=github:ihorleleka/wiki-kit"
for %%I in ("%~dp0.") do set "WIKI_KIT_AGENTS_DIR=%%~nxI"

call npx "%WIKI_KIT_PACKAGE%" update "%~dp0.." --agents-dir "%WIKI_KIT_AGENTS_DIR%" %*
exit /b %ERRORLEVEL%

