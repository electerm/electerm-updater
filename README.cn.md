# electerm-updater

[English](./README.md) | **简体中文**

electerm-updater 是 Electerm 桌面版的更新工具，既可以作为 Node.js 命令行工具独立运行，也可以作为安装库集成到桌面应用中。

在 Electerm 中点击 **Upgrade** 后，桌面应用会根据当前安装来源（`installSrc`）选择更新包，并在独立窗口中显示下载进度。下载期间可以取消。校验和安装准备完成后，点击 **Close Electerm and install** 会结束当前打开的会话，由独立进程完成安装。使用压缩包更新时，安装目录中的其他文件会保留，包括 Windows 便携版的用户配置。

| 安装来源 | 更新方式 |
| --- | --- |
| Windows `tar.gz`（含 portable、loose 和 Windows 7 版本） | 替换当前安装目录中的应用文件，然后重新打开 Electerm。 |
| Windows `installer.exe` | 运行该版本的安装程序。 |
| macOS `dmg`（含 mac10 版本） | 以只读方式挂载磁盘映像，将新的应用程序包复制到临时目录，再替换已安装的应用并重新打开。 |
| Linux `tar.gz` 或 AppImage | 替换解压目录中的应用文件或原有的 AppImage 文件，然后重新打开 Electerm。 |
| Linux `deb` 或 `rpm` | 通过系统包管理器安装新版本，然后重新打开 Electerm。 |

APPX 和 Snap 由各自的应用商店负责更新。`.blockmap` 文件是发布元数据。更新工具会根据指定的 GitHub 发布标签和安装来源精确匹配文件，包括架构和 `-legacy` 等后缀。从镜像下载的文件也会按 GitHub 公布的文件大小和 SHA-256 摘要进行校验。

## 独立运行

命令行工具需要 Node.js 18 或更高版本。以更新安装在 `/opt/electerm` 下的 Linux x64 压缩包版本为例，先关闭 Electerm，再运行：

```sh
npx --package=@electerm/updater electerm-updater v5.15.0 linux-x64.tar.gz /opt/electerm/electerm
```

前三个参数依次为目标版本的发布标签、当前安装来源和已安装的可执行文件路径。使用 AppImage 时，传入现有 AppImage 文件的路径；在 macOS 上，传入已安装的 `.app` 包内可执行文件的路径。

如果 Electerm 仍在运行，可以将其进程 ID（PID）作为第四个参数传入。安装程序会等待最多两分钟，让你关闭 Electerm。从桌面应用发起更新时，Electerm 会自动提供这些参数，并沿用已有的镜像和代理设置。

在 Linux 上，更新受保护的目录或通过包管理器安装时，系统会通过 PolicyKit 弹窗请求授权。Windows 和 macOS 会按需分别显示 UAC 和管理员授权提示。安装失败时，临时目录和安装日志会保留，方便排查。

## 开发与发布

在仓库根目录运行 `npm ci` 安装依赖，再运行 `npm test` 执行测试。使用 `npm run pack:check` 可以检查 npm 包将包含哪些文件。

首个版本 `0.1.0` 由维护者运行 `npm publish --access public` 手动发布。在 npm 的可信发布者设置中，GitHub 组织填写 `electerm`，仓库填写 `electerm-updater`，工作流文件名填写 `npm-publish.yml`。此后，在 `main` 分支上更新版本号时，CI 会运行测试，并从打包后的 npm 包验证命令行工具。检查通过后，CI 会发布新版本并附上来源证明（provenance）。
