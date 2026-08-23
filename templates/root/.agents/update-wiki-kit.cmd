@echo off
setlocal

if "%WIKI_KIT_PACKAGE%"=="" (
  for /f "usebackq delims=" %%P in (`node -e "const fs=require('fs');const path=require('path');const marker=path.resolve(process.argv[1],'.wiki-kit-install.json');try{const data=JSON.parse(fs.readFileSync(marker,'utf8'));const value=typeof data.package==='string'?data.package.trim():'';if(value)process.stdout.write(value);}catch{}" "%~dp0."`) do set "WIKI_KIT_PACKAGE=%%P"
)
if "%WIKI_KIT_PACKAGE%"=="" set "WIKI_KIT_PACKAGE=github:ihorleleka/Local-Rag-Wiki"
for %%I in ("%~dp0.") do set "WIKI_KIT_AGENTS_DIR=%%~nxI"

call npx "%WIKI_KIT_PACKAGE%" update "%~dp0.." --agents-dir "%WIKI_KIT_AGENTS_DIR%" %*
exit /b %ERRORLEVEL%
