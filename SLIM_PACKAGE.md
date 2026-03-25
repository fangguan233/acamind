# Acamind 减负包打包方式

本文件用于保留当前项目已经验证可用的减负打包命令，避免下次重新试错。

## 目的

生成仅包含源码和必要静态资源的压缩包，不包含：

- 本机 `node_modules`
- 前端构建产物
- Python 虚拟环境
- 缓存目录
- 本机运行数据
- 历史压缩包

## 当前验证通过的排除项

- `node_modules`
- `frontend/node_modules`
- `frontend/dist`
- `libs/copilot/node_modules`
- `libs/copilot/dist`
- `libs/react-client/node_modules`
- `libs/react-client/dist`
- `backend/.venv`
- `backend/.cache`
- `backend/__pycache__`
- `backend/.data`
- `backend/debug_artifacts`
- `.tmp`
- `new-api-docs-v1-main`
- `new-api-docs-v1-main.zip`
- `frontend/tsconfig.tsbuildinfo`
- `.env`
- `backend/.env`
- `Acamind-slim-*.zip`

## 执行目录

```powershell
Set-Location E:\myself_prodect\chainlit-main
```

## 推荐打包命令

```powershell
$ErrorActionPreference='Stop'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "Acamind-slim-$ts.zip"

tar.exe -a -cf $name `
  --exclude='./node_modules' `
  --exclude='./node_modules/*' `
  --exclude='./frontend/node_modules' `
  --exclude='./frontend/node_modules/*' `
  --exclude='./frontend/dist' `
  --exclude='./frontend/dist/*' `
  --exclude='./libs/copilot/node_modules' `
  --exclude='./libs/copilot/node_modules/*' `
  --exclude='./libs/copilot/dist' `
  --exclude='./libs/copilot/dist/*' `
  --exclude='./libs/react-client/node_modules' `
  --exclude='./libs/react-client/node_modules/*' `
  --exclude='./libs/react-client/dist' `
  --exclude='./libs/react-client/dist/*' `
  --exclude='./.tmp' `
  --exclude='./.tmp/*' `
  --exclude='./backend/.venv' `
  --exclude='./backend/.venv/*' `
  --exclude='./backend/.cache' `
  --exclude='./backend/.cache/*' `
  --exclude='./backend/__pycache__' `
  --exclude='./backend/__pycache__/*' `
  --exclude='./backend/.data' `
  --exclude='./backend/.data/*' `
  --exclude='./backend/debug_artifacts' `
  --exclude='./backend/debug_artifacts/*' `
  --exclude='./frontend/tsconfig.tsbuildinfo' `
  --exclude='./new-api-docs-v1-main' `
  --exclude='./new-api-docs-v1-main/*' `
  --exclude='./new-api-docs-v1-main.zip' `
  --exclude='./Acamind-slim-*.zip' `
  --exclude='./.env' `
  --exclude='./backend/.env' `
  .
```

## 打包完成后查看结果

```powershell
Get-Item $name | Select-Object FullName,@{Name='SizeMB';Expression={[math]::Round($_.Length/1MB,2)}},LastWriteTime
```

## 校验压缩包没有混入本机依赖/数据

将下面的文件名替换为实际生成的 zip：

```powershell
tar.exe -tf .\Acamind-slim-xxxxxx.zip | Select-String -Pattern '^\./node_modules/|^\./frontend/node_modules/|^\./frontend/dist/|^\./libs/copilot/node_modules/|^\./libs/react-client/node_modules/|^\./backend/.data/|^\./backend/.venv/|^\./backend/__pycache__/|^\./new-api-docs-v1-main/'
```

如果没有任何输出，说明这些目录已经被正确排除。

## 已验证样例

当前版本已生成：

```text
Acamind-slim-20260325-213352.zip
```

大小：

```text
21.05 MB
```

## 已知坑

1. `tar.exe` 对根目录大目录的模糊排除不稳定。
2. 不要只写 `--exclude='*/node_modules'`。
3. 应显式同时写：

```text
--exclude='./node_modules'
--exclude='./node_modules/*'
```

4. 其他关键目录同理，目录本身和目录内部内容都要写。
