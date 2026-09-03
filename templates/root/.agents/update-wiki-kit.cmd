@echo off
setlocal

if "%WIKI_KIT_PACKAGE%"=="" (
  for /f "usebackq delims=" %%P in (`node -e "const fs=require('fs');const path=require('path');const marker=path.resolve(process.argv[1],'.wiki-kit-install.json');try{const data=JSON.parse(fs.readFileSync(marker,'utf8'));const value=typeof data.package==='string'?data.package.trim():'';if(value)process.stdout.write(value);}catch{}" "%~dp0."`) do set "WIKI_KIT_PACKAGE=%%P"
)
if "%WIKI_KIT_PACKAGE%"=="" set "WIKI_KIT_PACKAGE=github:ihorleleka/Local-Rag-Wiki"
for %%I in ("%~dp0.") do set "WIKI_KIT_AGENTS_DIR=%%~nxI"

call npx "%WIKI_KIT_PACKAGE%" update "%~dp0.." --agents-dir "%WIKI_KIT_AGENTS_DIR%" %*
if errorlevel 1 exit /b %ERRORLEVEL%

for /f "usebackq delims=" %%I in (`node -e "const fs=require('fs');const path=require('path');const marker=path.resolve(process.argv[1],'.wiki-kit-install.json');const data=JSON.parse(fs.readFileSync(marker,'utf8'));if(typeof data.defaultImage!=='string'||!data.defaultImage.trim())throw new Error('installed wiki-kit marker has no default image');process.stdout.write(data.defaultImage.trim());" "%~dp0."`) do set "WIKI_KIT_IMAGE=%%I"
docker pull "%WIKI_KIT_IMAGE%"
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo Pulled wiki service image: %WIKI_KIT_IMAGE%
echo Restart the wiki service to use the new image:
for %%R in ("%~dp0..") do echo   npx "%WIKI_KIT_PACKAGE%" restart "%%~fR" --agents-dir "%WIKI_KIT_AGENTS_DIR%"
exit /b 0
