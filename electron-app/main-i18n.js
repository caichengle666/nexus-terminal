'use strict';

// Minimal dictionary for the few strings the Electron main process shows itself
// (tray menu, native dialogs). The renderer has its own vue-i18n setup.

const MESSAGES = {
  zh: {
    trayShow: '显示主窗口',
    trayQuit: '退出',
    trayHardwareAcceleration: '硬件加速',
    trayHardwareAcceleration_auto: '自动',
    trayHardwareAcceleration_on: '开启',
    trayHardwareAcceleration_off: '关闭',
    updateTitle: '安装 Nexus Terminal 更新',
    updateMessage: '更新文件已下载：{file}',
    updateDetailPortable: '将解压便携版并启动新版本。当前程序会先退出，请保存正在进行的工作。',
    updateDetailInstaller: '即将打开系统安装程序。请先保存工作，确认后当前程序将退出。',
    updateButtonPortable: '关闭并打开便携版',
    updateButtonInstaller: '关闭并打开安装程序',
    updateDetailDmg: '即将打开磁盘映像。当前程序退出后，请将 Nexus Terminal 拖入“应用程序”文件夹以替换旧版本。',
    updateButtonDmg: '关闭并打开磁盘映像',
    cancel: '取消',
    updateCancelled: '已取消安装。',
    updateAvailableTitle: 'Nexus Terminal 有新版本',
    updateAvailableBody: '新版本 {version} 已发布（当前 {current}）。请在 设置 → 关于 中下载更新。',
  },
  en: {
    trayShow: 'Show main window',
    trayQuit: 'Quit',
    trayHardwareAcceleration: 'Hardware acceleration',
    trayHardwareAcceleration_auto: 'Auto',
    trayHardwareAcceleration_on: 'On',
    trayHardwareAcceleration_off: 'Off',
    updateTitle: 'Install Nexus Terminal update',
    updateMessage: 'Update downloaded: {file}',
    updateDetailPortable: 'The portable version will be extracted and the new version started. Nexus Terminal will quit first, so save your work.',
    updateDetailInstaller: 'The system installer will open. Save your work first; Nexus Terminal will quit after you confirm.',
    updateButtonPortable: 'Quit and open portable version',
    updateButtonInstaller: 'Quit and open installer',
    updateDetailDmg: 'The disk image will open. After Nexus Terminal quits, drag it into the Applications folder to replace the old version.',
    updateButtonDmg: 'Quit and open disk image',
    cancel: 'Cancel',
    updateCancelled: 'Installation cancelled.',
    updateAvailableTitle: 'Nexus Terminal update available',
    updateAvailableBody: 'Version {version} is available (current {current}). Open Settings → About to download it.',
  },
  ja: {
    trayShow: 'メインウィンドウを表示',
    trayQuit: '終了',
    trayHardwareAcceleration: 'ハードウェアアクセラレーション',
    trayHardwareAcceleration_auto: '自動',
    trayHardwareAcceleration_on: 'オン',
    trayHardwareAcceleration_off: 'オフ',
    updateTitle: 'Nexus Terminal の更新をインストール',
    updateMessage: '更新ファイルをダウンロードしました：{file}',
    updateDetailPortable: 'ポータブル版を展開して新しいバージョンを起動します。現在のアプリは先に終了するため、作業内容を保存してください。',
    updateDetailInstaller: 'システムのインストーラーを開きます。先に作業内容を保存してください。確認後、現在のアプリは終了します。',
    updateButtonPortable: '終了してポータブル版を開く',
    updateButtonInstaller: '終了してインストーラーを開く',
    updateDetailDmg: 'ディスクイメージを開きます。現在のアプリが終了したら、Nexus Terminal を「アプリケーション」フォルダにドラッグして古いバージョンを置き換えてください。',
    updateButtonDmg: '終了してディスクイメージを開く',
    cancel: 'キャンセル',
    updateCancelled: 'インストールをキャンセルしました。',
    updateAvailableTitle: 'Nexus Terminal の新しいバージョン',
    updateAvailableBody: 'バージョン {version} が公開されました（現在 {current}）。設定 → バージョン情報 から更新をダウンロードしてください。',
  },
};

/** Maps an Electron locale ('zh-CN', 'ja', 'en-US', ...) to a dictionary key. */
function resolveMainLocale(locale) {
  const value = String(locale || '').toLowerCase();
  if (value.startsWith('zh')) return 'zh';
  if (value.startsWith('ja')) return 'ja';
  return 'en';
}

function createTranslator(getLocale) {
  return (key, params = {}) => {
    const dictionary = MESSAGES[resolveMainLocale(typeof getLocale === 'function' ? getLocale() : getLocale)];
    const template = dictionary[key] ?? MESSAGES.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

module.exports = { MESSAGES, createTranslator, resolveMainLocale };
