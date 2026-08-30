![banner.png](https://lsky.tuyu.me/i/2025/04/30/681209e053db7.png)

---

<div align="center">

[![Docker](https://img.shields.io/badge/-Docker-2496ED?style=flat-square&logo=docker&logoColor=white)][docker-url] [![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-4CAF50?style=flat-square)](https://github.com/Heavrnl/nexus-terminal/blob/main/LICENSE)

[docker-url]: https://hub.docker.com/r/heavrnl/nexus-terminal-frontend

</div>



## 📖 Overview

**Nexus Terminal** is a modern, feature-rich web-based SSH / RDP / VNC client dedicated to providing a highly customizable remote connection experience.

## ✨ Features

*   Manage SSH and SFTP connections with multiple tabs
*   Support remote access to desktops via RDP/VNC protocol
*   Utilizes Monaco Editor for online file editing
*   Integrated multi-factor login security mechanisms, including human verification (hCaptcha, Google reCAPTCHA) and two-factor authentication (2FA)
*   Highly customizable interface themes and layout styles
*   Built-in simple Docker container management panel for easy container operations
*   Supports IP whitelisting and blacklisting, with automatic banning for abnormal access
*   Notification system (e.g., login reminders, anomaly alerts)
*   Audit logs for comprehensive recording of user behavior and system changes
*   Lightweight Node.js-based backend with low resource consumption
*   Built-in heartbeat keep-alive mechanism to ensure stable connections
*   Focus Switcher: Allows switching between input components on the page, supporting customizable switching order and hotkeys.

## 📸 Screenshots



|                            Login Interface                            |
|:-------------------------------------------------------------:|
| ![Login_en.png](https://lsky.tuyu.me/i/2025/04/30/68123e4016788.png) |

---

|                            Terminal Interface                             |
|:-------------------------------------------------------------:|
| ![workspace_en.png](https://lsky.tuyu.me/i/2025/04/30/68123e410d34f.png) |



---



|                          Style Settings                            |                          Layout Settings                            |                          Settings Panel                            |
|:-------------------------------------------------------------:|:-------------------------------------------------------------:|:-------------------------------------------------------------:|
| ![ui_en.png](https://lsky.tuyu.me/i/2025/04/30/68123e40570cc.png) | ![layout_en.png](https://lsky.tuyu.me/i/2025/04/30/68123e4122276.png) | ![settings_en.png](https://lsky.tuyu.me/i/2025/04/30/68123e4036cd6.png) |

## 🖥️ Desktop Client

> Removed web-specific features such as various login verifications and session suspension.

https://github.com/Heavrnl/nexus-terminal/releases/latest

For regular Windows use, download `Nexus Terminal Setup ...exe`; the installer lets you choose the installation directory. For a no-install option, download `Nexus Terminal Portable win-unpacked.zip`, extract it, and run the app directly; its data stays in the extracted directory. On macOS, download the `.dmg` and move the app to Applications before launching it.

## 🚀 Quick Start

### 1️⃣ Configure Environment

> It is recommended to deploy in a Debian (AMD64 architecture) environment. Since I do not have an ARM device, compatibility with ARM is not guaranteed.

Use the one-line installer. The first run installs the containers; running it again pulls the latest images and updates them while preserving `data` and `.env`.


```bash
curl -fsSL https://raw.githubusercontent.com/caichengle666/nexus-terminal/main/install.sh | bash
```

The script opens an interactive installer. The installation directory, image tag, and confirmation all have defaults, so pressing Enter through the prompts completes the default installation. On a headless server, add `--non-interactive`:
```bash
curl -fsSL https://raw.githubusercontent.com/caichengle666/nexus-terminal/main/install.sh | bash -s -- --non-interactive
```

The default installation directory is `/opt/nexus-terminal`. To choose a directory or image tag:
```bash
curl -fsSL https://raw.githubusercontent.com/caichengle666/nexus-terminal/main/install.sh | bash -s -- --dir /srv/nexus-terminal --tag 0.9.22.17
```


> ⚠️ **Note:**
>
> * The one-line script automatically uses the compatible `guacamole/guacd:1.6.0-RC1` image on **ARM64**.
> * The project images do not provide **ARMv7** builds. Use an AMD64 or ARM64 host.

Configure nginx
```conf
location / {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_redirect off;
    proxy_pass http://127.0.0.1:18111;
}
```

Configure IPv6 for Docker (optional — you can skip this if you don't use IPv6 to connect to the server).

Add the following content to `/etc/docker/daemon.json`:
```json
{
  "ipv6": true,
  "fixed-cidr-v6": "fd00::/80",
  "ip6tables": true,
  "experimental": true
}
```
Then restart the Docker service:
```
sudo systemctl restart docker
```

### 2️⃣ Start the Service

The one-line installer starts the service automatically. For a manual deployment, run `docker compose up -d` from the installation directory.

### 3️⃣ Update
Run the one-line installer again. It validates the downloaded Compose file, backs up the current Compose and `.env`, pulls the latest images, and updates the containers without replacing `data`. You can also update manually:
```bash
docker compose pull
docker compose up -d
```
## 📚 Usage Guide

### Suspend Session Component

You can right-click in the SSH tab to select "Suspend Session" (long-press on mobile). Once suspended, even if the web connection is lost, the backend will automatically take over and keep the SSH connection active. You can resume the session at any time via the panel. This ensures that tasks such as compilation or long-running processes won’t be interrupted due to network issues.


### Command Input Component

1.  **Tab Switching**: When the command input box has focus, use `Alt + ↑/↓` to switch between SSH session tabs, and `Alt + ←/→` to switch between text editor tabs.
2.  **Command Sync** (needs to be enabled in settings): When enabled, text entered in the command input box will be synchronized in real-time to the selected target input source. Use the `↑/↓` keys to select menu command items, then press `Enter` to send the selected command.

### File Manager Component

1.  **Quick File Selection**: When the file search box has focus, you can use the `↑/↓` keys to quickly select files.
2.  **Drag and Drop Upload**: Supports dragging files or folders from outside the browser for uploading. **Note:** When uploading a large number of files or deeply nested folders, it is recommended to compress them first to avoid browser freezes.
3.  **Internal Drag and Drop**: You can directly drag and drop files or folders within the file manager to move them.
4.  **Multiple Selection**: Hold down the `Ctrl` or `Shift` key to select multiple files or folders.
5.  **Context Menu**: Provides common file operations such as copy, paste, cut, delete, rename, and modify permissions.

### Command History Component

1.  **View Full Command**: When a historical command is too long and truncated, hover the mouse over the command to view the complete instruction content.

### Terminal Component

1. Press **Ctrl + Shift + C** to copy, and **Ctrl + Shift + V** to paste.


### General Operations

1.  **Zoom**: In the terminal, file manager, text editor components, and quick command view, you can use `Ctrl + mouse wheel` to zoom.
2. **Sidebar**: The expanded sidebar can have its width adjusted by dragging.
3. **Tab Bar**: Right-clicking on the SSH tab bar or the file manager tab bar will open a context menu with the following options: Close, Close Tabs to the Left, Close Other Tabs, and Close Tabs to the Right.
4. **Tab Group Fold Bar**: You can directly click on the tab name in the view to rename the tab.
5. **Automatic Reconnection**: When the connection is lost, you can press Enter in the command input box or terminal, or click the same SSH connection in the connection list to trigger automatic reconnection.

### Others


1. **On mobile devices, you can zoom in or out on the terminal font using a two-finger gesture.**
2. To enable Passkey login, set the `RP_ID` and `RP_ORIGIN` environment variables in the `.env` file.



## ⚠️ Notes

1.  **Dual File Managers**: You can add two file manager components in the layout (experimental feature, may be unstable).
2.  **Multiple Text Editors**: The functionality to add multiple text editors in the same layout has not yet been implemented.
3. For **ARMv7** users, please use the [docker-compose.yml](https://github.com/Heavrnl/nexus-terminal/blob/main/doc/arm/docker-compose.yml) provided here.
Since Apache Guacamole does not provide an ARMv7-compatible image for `guacd`, the RDP/VNC feature has been disabled, and related images will not be pulled for now.
4. Since I don't have an ARM machine on hand, I haven't conducted actual testing, so unexpected bugs may occur during runtime.
5. For data backup, please back up the **data** folder in the directory yourself. This project does not provide any backup functionality.


## 💐 Acknowledgements

* The preset theme schemes are based on the excellent [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) project.

## ☕ Donate

If you find this project helpful, feel free to buy me a coffee through the following ways:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/0heavrnl)


## 📄 License

This project is licensed under the [GPL-3.0](LICENSE) license. See the [LICENSE](LICENSE) file for details.
