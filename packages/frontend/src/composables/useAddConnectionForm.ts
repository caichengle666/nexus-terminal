import { ref, reactive, watch, computed, onMounted, onBeforeUnmount, toRefs } from 'vue';
import { isCancel } from 'axios';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import apiClient from '../utils/apiClient';
import { useConnectionsStore, ConnectionInfo } from '../stores/connections.store';
import { useProxiesStore } from '../stores/proxies.store';
import { useTagsStore } from '../stores/tags.store';
import { useSshKeysStore } from '../stores/sshKeys.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from './useConfirmDialog';
import { useAlertDialog } from './useAlertDialog';

// Define Props interface based on the component's props
interface AddConnectionFormProps {
  connectionToEdit: ConnectionInfo | null;
}

// 与后端 ssh.service.ts 中的 TEST_TIMEOUT 保持一致 (每一跳的超时)
const BACKEND_TEST_TIMEOUT_PER_HOP_MS = 15000;
const TEST_REQUEST_TIMEOUT_MARGIN_MS = 5000;

// Define Emits type based on the component's emits
type AddConnectionFormEmits = {
  (e: 'close'): void;
  (e: 'connection-added'): void;
  (e: 'connection-updated'): void;
  (e: 'connection-deleted'): void;
};

export function useAddConnectionForm(props: AddConnectionFormProps, emit: AddConnectionFormEmits) {
  const { connectionToEdit } = toRefs(props);

  const { t } = useI18n();
  const { showConfirmDialog } = useConfirmDialog();
  const { showAlertDialog } = useAlertDialog();
  const connectionsStore = useConnectionsStore();
  const proxiesStore = useProxiesStore();
  const tagsStore = useTagsStore();
  const sshKeysStore = useSshKeysStore();
  const uiNotificationsStore = useUiNotificationsStore();

  const { isLoading: isConnLoading, error: connStoreError, connections } = storeToRefs(connectionsStore);
  const { proxies, isLoading: isProxyLoading, error: proxyStoreError } = storeToRefs(proxiesStore);
  const { tags, isLoading: isTagLoading, error: tagStoreError } = storeToRefs(tagsStore);
  const { sshKeys, isLoading: isSshKeyLoading, error: sshKeyStoreError } = storeToRefs(sshKeysStore);

  // 表单数据模型
  const initialFormData = {
    type: 'SSH' as 'SSH' | 'RDP' | 'VNC',
    name: '',
    host: '',
    port: 22,
    username: '',
    auth_method: 'password' as 'password' | 'key',
    password: '',
    private_key: '',
    passphrase: '',
    selected_ssh_key_id: null as number | null,
    proxy_id: null as number | null,
    jump_chain: null as Array<any> | null, 
    proxy_type: null as 'proxy' | 'jump' | null, 
    tag_ids: [] as number[],
    notes: '',
    vncPassword: '',
  };
  const formData = reactive({ ...initialFormData });

  const formError = ref<string | null>(null); // 表单级别的错误信息
  const advancedConnectionMode = ref<'proxy' | 'jump'>('proxy');

  // 合并所有 store 的加载和错误状态
  const isLoading = computed(() => isConnLoading.value || isProxyLoading.value || isTagLoading.value || isSshKeyLoading.value); // +++ Include SSH Key loading +++
  const storeError = computed(() => connStoreError.value || proxyStoreError.value || tagStoreError.value || sshKeyStoreError.value); // +++ Include SSH Key error +++

  // 测试连接状态
  const testStatus = ref<'idle' | 'testing' | 'success' | 'error'>('idle');
  const testResult = ref<string | number | null>(null); // 存储延迟或错误信息
  const testLatency = ref<number | null>(null); // 单独存储延迟用于颜色计算

  // Script Mode State
  const isScriptModeActive = ref(false);
  const scriptInputText = ref('');

  // 计算属性判断是否为编辑模式
  const isEditMode = computed(() => !!connectionToEdit.value);

  // When switching to edit mode, disable script mode
  watch(isEditMode, (editing) => {
    if (editing) {
      isScriptModeActive.value = false;
    }
  });

  // 计算属性动态设置表单标题
  const formTitle = computed(() => {
      return isEditMode.value ? t('connections.form.titleEdit') : t('connections.form.title');
  });

  // 计算属性动态设置提交按钮文本
  const submitButtonText = computed(() => {
      if (isLoading.value) {
          return isEditMode.value ? t('connections.form.saving') : t('connections.form.adding');
      }
      return isEditMode.value ? t('connections.form.confirmEdit') : t('connections.form.confirm');
  });

  // 监听 prop 变化以填充或重置表单
  watch(connectionToEdit, (newVal) => {
      formError.value = null; // 清除错误
      if (newVal) {
          formData.type = newVal.type as 'SSH' | 'RDP' | 'VNC';
          formData.name = newVal.name;
          formData.host = newVal.host;
          formData.port = newVal.port;
          formData.username = newVal.username;
          formData.auth_method = newVal.auth_method;
          formData.proxy_id = newVal.proxy_id ?? null;
          formData.proxy_type = newVal.proxy_type ?? null; 
          formData.jump_chain = newVal.jump_chain ? JSON.parse(JSON.stringify(newVal.jump_chain)) : null; 
          console.log('[Debug] watch connectionToEdit - newVal.jump_chain:', newVal.jump_chain);
          console.log('[Debug] watch connectionToEdit - formData.jump_chain initialized:', formData.jump_chain);
          formData.notes = newVal.notes ?? '';
          formData.tag_ids = newVal.tag_ids ? [...newVal.tag_ids] : [];

          if (newVal.type === 'SSH' && newVal.auth_method === 'key') {
              formData.selected_ssh_key_id = newVal.ssh_key_id ?? null;
          } else {
              formData.selected_ssh_key_id = null;
          }

          if (newVal.proxy_type === 'jump' && newVal.jump_chain && newVal.jump_chain.length > 0) {
              advancedConnectionMode.value = 'jump';
          } else if (newVal.proxy_type === 'proxy' && newVal.proxy_id !== null && newVal.proxy_id !== undefined) {
              advancedConnectionMode.value = 'proxy';
          }
          else if (newVal.jump_chain && newVal.jump_chain.length > 0 && (newVal.proxy_id === null || newVal.proxy_id === undefined)) {
             advancedConnectionMode.value = 'jump';
          } else {
             advancedConnectionMode.value = 'proxy';
          }

          formData.password = '';
          formData.private_key = '';
          formData.passphrase = '';
          if (newVal.type !== 'VNC') {
               formData.vncPassword = '';
          } else {
              formData.vncPassword = ''; // 保持原逻辑或根据需求调整
          }
     } else {
         Object.assign(formData, initialFormData);
         formData.tag_ids = [];
         formData.selected_ssh_key_id = null;
         formData.notes = '';
         formData.vncPassword = '';
         formData.jump_chain = null; 
         formData.proxy_type = null;
         console.log('[Debug] watch connectionToEdit - formData.jump_chain reset');
         advancedConnectionMode.value = 'proxy'; 
    }
  }, { immediate: true });

  // 组件挂载时获取代理、标签和 SSH 密钥列表
  onMounted(() => {
      proxiesStore.fetchProxies();
      tagsStore.fetchTags();
      sshKeysStore.fetchSshKeys();
  });

  // 监听连接类型变化，动态调整默认端口
  watch(() => formData.type, (newType) => {
      if (newType === 'RDP') {
          if (formData.port === 22 || formData.port === 5900 || formData.port === 5901) formData.port = 3389;
          formData.auth_method = 'password';
          formData.selected_ssh_key_id = null;
      } else if (newType === 'SSH') {
          if (formData.port === 3389 || formData.port === 5900 || formData.port === 5901) formData.port = 22;
      } else if (newType === 'VNC') {
          if (formData.port === 22 || formData.port === 3389) formData.port = 5900;
          formData.auth_method = 'password';
          formData.selected_ssh_key_id = null;
      }
  });

  
  watch([() => formData.type, advancedConnectionMode], ([newType, newAdvMode], [oldType, oldAdvMode]) => {
    if (newType === 'SSH') {
      if (newAdvMode === 'proxy') {
        formData.proxy_type = 'proxy';
      } else if (newAdvMode === 'jump') {
        formData.proxy_type = 'jump';
      } else {
        formData.proxy_type = null;
      }
    } else {
      formData.proxy_type = null;
    }
    console.log(`[Debug] useAddConnectionForm: proxy_type set to ${formData.proxy_type} (type: ${newType}, mode: ${newAdvMode})`);
  }, { immediate: true });

  // Helper function to parse IP range
  const parseIpRange = (ipRangeStr: string): string[] | { error: string } => {
    if (!ipRangeStr.includes('~')) {
        return { error: 'not_a_range' };
    }
    const parts = ipRangeStr.split('~');
    if (parts.length !== 2) {
        return { error: t('connections.form.errorInvalidIpRangeFormat', 'IP 范围格式应为 start_ip~end_ip') };
    }

    const [startIpStr, endIpStr] = parts.map(p => p.trim());

    const ipRegex = /^((\d{1,3}\.){3})\d{1,3}$/;
    if (!ipRegex.test(startIpStr) || !ipRegex.test(endIpStr)) {
        return { error: t('connections.form.errorInvalidIpFormat', '起始或结束 IP 地址格式无效') };
    }

    const startIpParts = startIpStr.split('.');
    const endIpParts = endIpStr.split('.');

    if (startIpParts.slice(0, 3).join('.') !== endIpParts.slice(0, 3).join('.')) {
        return { error: t('connections.form.errorIpRangeNotSameSubnet', 'IP 范围必须在同一个C段子网中 (例如 1.2.3.x ~ 1.2.3.y)') };
    }

    const startSuffix = parseInt(startIpParts[3], 10);
    const endSuffix = parseInt(endIpParts[3], 10);

    if (isNaN(startSuffix) || isNaN(endSuffix) || startSuffix < 0 || startSuffix > 255 || endSuffix < 0 || endSuffix > 255) {
        return { error: t('connections.form.errorInvalidIpSuffix', 'IP 地址最后一段必须是 0-255 之间的数字') };
    }

    if (startSuffix > endSuffix) {
        return { error: t('connections.form.errorIpRangeStartAfterEnd', 'IP 范围的起始 IP 不能大于结束 IP') };
    }

    const numIps = endSuffix - startSuffix + 1;
    if (numIps <= 0) {
         return { error: t('connections.form.errorIpRangeEmpty', 'IP 范围不能为空。') };
    }

    const baseIp = startIpParts.slice(0, 3).join('.');
    const ips: string[] = [];
    for (let i = startSuffix; i <= endSuffix; i++) {
        ips.push(`${baseIp}.${i}`);
    }
    return ips;
  };

  // Helper function to parse a single script line using minimist

  
  /**
   * 把 OpenSSH 命令行转换成脚本格式 "user@host:port ..."。
   * 支持 ssh [-p PORT] [-l USER] [其它常见选项] [user@]host[:port] 以及 ssh://user@host:port。
   * 目标之后的参数按原脚本选项继续解析。非 ssh 开头的行原样返回。
   */
  const normalizeOpenSshCommand = (line: string): { line: string; error?: string } => {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0]?.toLowerCase() !== 'ssh') return { line };
    let port: string | null = null;
    let user: string | null = null;
    let dest: string | null = null;
    let i = 1;
    const valueOpts = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-m', '-O', '-o', '-Q', '-R', '-S', '-W', '-w']);
    for (; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === '-p' || tok === '-l') {
        const val = tokens[++i];
        if (!val) return { line, error: t('connections.form.scriptErrorMissingValueForKey', { key: tok }) };
        if (tok === '-p') port = val; else user = val;
      } else if (/^-p\d+$/.test(tok)) {
        port = tok.slice(2);
      } else if (valueOpts.has(tok)) {
        i++; // 忽略这些选项及其值
      } else if (/^-[A-Za-z0-9]+$/.test(tok)) {
        // 无值的开关（-v, -A, -4 等），忽略
      } else {
        dest = tok;
        i++;
        break;
      }
    }
    if (!dest) return { line, error: t('connections.form.scriptErrorInvalidUserHostPortFormat', { part: line.trim() }) };
    dest = dest.replace(/^ssh:\/\//i, '').replace(/\/$/, '');
    let host = dest;
    const at = dest.lastIndexOf('@');
    if (at !== -1) {
      user = dest.slice(0, at);
      host = dest.slice(at + 1);
    }
    const portMatch = host.match(/^(.*):(\d+)$/);
    if (portMatch) {
      host = portMatch[1];
      if (!port) port = portMatch[2];
    }
    if (!user || !host) return { line, error: t('connections.form.scriptErrorInvalidUserHostPortFormat', { part: dest }) };
    const rest = tokens.slice(i).join(' ');
    return { line: `${user}@${host}${port ? `:${port}` : ''}${rest ? ` ${rest}` : ''}` };
  };

  const parseScriptLine = (line: string): { type: 'SSH' | 'RDP' | 'VNC', userHostPort: string, name: string, password: string | null, keyName: string | null, proxyName: string | null, tags: string[], note: string | null, error?: string } => {
    line = line.trim();
    if (!line) {
      return { type: 'SSH', userHostPort: '', name: '', password: null, keyName: null, proxyName: null, tags: [], note: null, error: t('connections.form.scriptErrorEmptyLine', 'Input line cannot be empty') };
    }

    // 0. 兼容直接粘贴的 OpenSSH 命令，如 "ssh -p 2222 user@host [-name xx ...]" 或 "ssh user@host"
    const openSsh = normalizeOpenSshCommand(line);
    if (openSsh.error) {
      return { type: 'SSH', userHostPort: line, name: '', password: null, keyName: null, proxyName: null, tags: [], note: null, error: openSsh.error };
    }
    line = openSsh.line;

    // 1. Extract user@host:port
    const firstSpaceIndex = line.indexOf(' ');
    const userHostPortPart = firstSpaceIndex === -1 ? line : line.substring(0, firstSpaceIndex);
    const optionsString = firstSpaceIndex === -1 ? '' : line.substring(firstSpaceIndex + 1).trim();

    // 2. Validate user@host:port (allow user@host without port)
    const userHostPortRegex = /^([^@\s]+)@([^:\s]+)(?::([0-9]+))?$/;
    const match = userHostPortPart.match(userHostPortRegex);
    if (!match) {
      return { type: 'SSH', userHostPort: userHostPortPart, name: '', password: null, keyName: null, proxyName: null, tags: [], note: null, error: t('connections.form.scriptErrorInvalidUserHostPortFormat', { part: userHostPortPart }) };
    }
    const [, user, host /*, portStr */] = match; // portStr not used for now
    const defaultName = `${user}@${host}`; // Default name

    // 3. Initialize results and defaults
    let type: 'SSH' | 'RDP' | 'VNC' = 'SSH';
    let name: string = defaultName;
    let password: string | null = null;
    let keyName: string | null = null;
    let proxyName: string | null = null;
    let tags: string[] = [];
    let note: string | null = null;

    // 4. Parse optionsString
    // Regex to split by space, respecting quotes
    const args = optionsString.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg.startsWith('-')) {
        const key = arg.substring(1).toLowerCase();
        i++; // Move to the expected position of the value

        if (key === 'tags') {
          // Handle -tags, which can be followed by zero or more tags
          tags = [];
          while (i < args.length && !args[i].startsWith('-')) {
            tags.push(args[i].replace(/^"|"$/g, '')); // Remove surrounding quotes
            i++;
          }
          // No need to i++ here, the next loop iteration or outer loop handles it
        } else if (key === 'note') {
          // Handle -note, which consumes the rest of the line
          const noteParts = [];
          while (i < args.length) {
            noteParts.push(args[i]);
            i++;
          }
          note = noteParts.join(' ').replace(/^"|"$/g, ''); // Join parts and remove quotes
          break; // Exit the outer loop as note consumes the rest
        } else if (i >= args.length) {
           // All other options require a value
           return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorMissingValueForKey', { key: arg }) };
        } else {
           // Handle options that require a single value
           const value = args[i].replace(/^"|"$/g, ''); // Remove surrounding quotes
           switch (key) {
             case 'type':
               const typeValue = value.toUpperCase();
               if (typeValue === 'SSH' || typeValue === 'RDP' || typeValue === 'VNC') {
                 type = typeValue;
               } else {
                 return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorInvalidType', { value: args[i] }) };
               }
               break;
             case 'name':
               name = value;
               break;
             case 'p': // password
               password = value;
               break;
             case 'k': // key name
               keyName = value;
               break;
             case 'proxy':
               proxyName = value;
               break;
             default:
               return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorUnknownOption', { option: arg }) };
           }
           i++; // Move past the value
        }
      } else {
        // Arguments after user@host:port must start with '-'
        return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorUnexpectedArgument', { argument: arg }) };
      }
    }

    // 5. Validation based on type
    if (type === 'SSH') {
      // SSH 未提供 -p/-k 时按空密码的密码认证处理（内网设备可能无密码）
      if (!password && !keyName) password = '';
    } else if (type === 'RDP') {
      if (!password) {
        return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorMissingPasswordForRdp') };
      }
      if (keyName) {
         return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorKeyNotApplicableForRdp') };
      }
    } else if (type === 'VNC') {
      if (!password) {
         return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorMissingPasswordForVnc') };
      }
       if (keyName) {
         return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note, error: t('connections.form.scriptErrorKeyNotApplicableForVnc') };
      }
    }

    return { type, userHostPort: userHostPortPart, name, password, keyName, proxyName, tags, note };
  };

  // 处理表单提交
  const handleScriptModeSubmit = async () => {
    const lines = scriptInputText.value.split('\n').filter(line => line.trim() !== '');

    if (lines.length === 0) {
      uiNotificationsStore.showError(t('connections.form.scriptModeEmpty', '脚本输入不能为空。'));
      return;
    }

    let allConnectionsValid = true;
    const connectionsToAdd = [];

    for (const line of lines) {
      const parsed = parseScriptLine(line);
      if (parsed.error) {
        uiNotificationsStore.showError(t('connections.form.scriptErrorInLine', { line, error: parsed.error }));
        allConnectionsValid = false;
        break;
      }

      if (!parsed.type) {
          uiNotificationsStore.showError(t('connections.form.scriptErrorMissingType', { line }));
          allConnectionsValid = false;
          break;
      }

      const [userHost, portStr] = parsed.userHostPort.split(':');
      const [username, host] = userHost.split('@');
      const port = portStr ? parseInt(portStr, 10) : (parsed.type === 'RDP' ? 3389 : (parsed.type === 'VNC' ? 5900 : 22));

      if (!username || !host) {
          uiNotificationsStore.showError(t('connections.form.scriptErrorInvalidUserHostFormat', { line }));
          allConnectionsValid = false;
          break;
      }
      if (isNaN(port) || port <= 0 || port > 65535) {
          uiNotificationsStore.showError(t('connections.form.scriptErrorInvalidPort', { line, port: portStr || (parsed.type === 'RDP' ? '3389' : (parsed.type === 'VNC' ? '5900' : '22')) }));
          allConnectionsValid = false;
          break;
      }

      const connectionData: any = {
        type: parsed.type,
        name: parsed.name || `${username}@${host}`,
        host,
        port,
        username,
        notes: parsed.note || '',
        tag_names: parsed.tags,
        proxy_name: parsed.proxyName,
      };

      if (parsed.type === 'SSH') {
        connectionData.auth_method = parsed.keyName ? 'key' : 'password';
        if (connectionData.auth_method === 'password') {
          connectionData.password = parsed.password ?? '';
        } else {
          if (!parsed.keyName) {
            uiNotificationsStore.showError(t('connections.form.scriptErrorMissingKeyNameForSsh', { line }));
            allConnectionsValid = false;
            break;
          }
          connectionData.ssh_key_name = parsed.keyName;
        }
      } else if (parsed.type === 'RDP' || parsed.type === 'VNC') {
        if (!parsed.password) {
          uiNotificationsStore.showError(t('connections.form.scriptErrorMissingPasswordForType', { line, type: parsed.type }));
          allConnectionsValid = false;
          break;
        }
        connectionData.password = parsed.password;
      }
      connectionsToAdd.push(connectionData);
    }

    if (!allConnectionsValid || connectionsToAdd.length === 0) {
      if (connectionsToAdd.length > 0 && !allConnectionsValid) {
          // Errors were already shown
      } else if (lines.length > 0 && connectionsToAdd.length === 0 && allConnectionsValid) {
          uiNotificationsStore.showError(t('connections.form.scriptErrorInternal', '内部解析错误。'));
      }
      return;
    }

    const fullyProcessedConnections = [];
    let resolutionErrorOccurred = false;

    for (const connData of connectionsToAdd) {
      if (connData.tag_names && connData.tag_names.length > 0) {
        const tagIds = [];
        for (const tagName of connData.tag_names) {
          let foundTag = tags.value.find(t_ => t_.name === tagName); // Renamed t to t_ to avoid conflict
          if (!foundTag) {
            // 自动创建不存在的标签
            const newTag = await tagsStore.addTag(tagName);
            if (newTag) {
              foundTag = newTag;
              uiNotificationsStore.showInfo(t('connections.form.scriptTagCreated', { tagName }));
              // 确保标签列表已更新
              await tagsStore.fetchTags();
            } else {
              uiNotificationsStore.showError(t('connections.form.scriptErrorTagCreationFailed', { tagName }));
              resolutionErrorOccurred = true;
              break;
            }
          }
          tagIds.push(foundTag.id);
        }
        if (resolutionErrorOccurred) break;
        connData.tag_ids = tagIds;
      } else {
        connData.tag_ids = [];
      }
      delete connData.tag_names;

      if (connData.type === 'SSH' && connData.auth_method === 'key' && connData.ssh_key_name) {
        const foundKey = sshKeys.value.find(k => k.name === connData.ssh_key_name);
        if (foundKey) {
          connData.ssh_key_id = foundKey.id;
        } else {
          uiNotificationsStore.showError(t('connections.form.scriptErrorSshKeyNotFound', { keyName: connData.ssh_key_name }));
          resolutionErrorOccurred = true;
          break;
        }
        delete connData.ssh_key_name;
      }
      
      if (connData.proxy_name) {
       const foundProxy = proxies.value.find(p => p.name === connData.proxy_name);
       if (foundProxy) {
         connData.proxy_id = foundProxy.id;
       } else {
         uiNotificationsStore.showError(t('proxies.errors.notFound', { name: connData.proxy_name })); // Assuming you add this translation
         resolutionErrorOccurred = true;
         break;
       }
       delete connData.proxy_name;
     }

      if (connData.type !== 'SSH' || connData.auth_method !== 'key') delete connData.ssh_key_id;
      if (connData.type === 'SSH' && connData.auth_method === 'key') delete connData.password;
      if (connData.type !== 'SSH') delete connData.auth_method;

      fullyProcessedConnections.push(connData);
    }

    if (resolutionErrorOccurred || (fullyProcessedConnections.length === 0 && lines.length > 0)) {
      if (!resolutionErrorOccurred && lines.length > 0 && fullyProcessedConnections.length === 0) {
           uiNotificationsStore.showError(t('connections.form.scriptErrorNothingToProcess', '没有可处理的有效连接数据。'));
      }
      return;
    }
    
    if (fullyProcessedConnections.length === 0) {
      return;
    }

    uiNotificationsStore.showInfo(t('connections.form.scriptModeAddingConnections', { count: fullyProcessedConnections.length }));

    let successCount = 0;
    let errorCount = 0;
    let firstErrorEncountered: string | null = null;

    for (const finalConnectionData of fullyProcessedConnections) {
      const success = await connectionsStore.addConnection(finalConnectionData);
      if (success) {
        successCount++;
      } else {
        errorCount++;
        if (!firstErrorEncountered) {
          firstErrorEncountered = connectionsStore.error || t('errors.unknown', '未知错误');
        }
        console.error(`Failed to add connection: ${finalConnectionData.name}`, connectionsStore.error);
      }
    }

    if (errorCount > 0) {
      const message = t('connections.form.errorBatchAddResult', { successCount, errorCount, firstErrorEncountered: firstErrorEncountered || t('errors.unknown', '未知错误') });
      if (successCount > 0) {
        uiNotificationsStore.showWarning(message);
      } else {
        uiNotificationsStore.showError(message);
      }
    }
    
    if (successCount > 0) {
      if (errorCount === 0) {
          uiNotificationsStore.showSuccess(t('connections.form.successBatchAddResult', { successCount }));
      }
      emit('connection-added');
      if (errorCount === 0) {
          scriptInputText.value = '';
      }
    }
  };

  // 跳板机链的深拷贝，去除未选择的 (null) 条目
  const getCleanJumpChain = (): number[] | null => {
    if (!formData.jump_chain) return null;
    const ids = (JSON.parse(JSON.stringify(formData.jump_chain)) as Array<number | null | undefined>)
      .filter((id): id is number => typeof id === 'number');
    return ids.length > 0 ? ids : null;
  };

  const handleSubmit = async () => {
    if (isScriptModeActive.value) {
      await handleScriptModeSubmit();
      return;
    }

    formError.value = null;
    connectionsStore.error = null;
    proxiesStore.error = null;

    const availableTagIds = tags.value.map(t_ => t_.id);
    const currentSelectedValidTagIds = formData.tag_ids.filter(id => availableTagIds.includes(id));

    if (!formData.host || !formData.username) {
      uiNotificationsStore.showError(t('connections.form.errorRequiredFields'));
      return;
    }
    if (formData.port <= 0 || formData.port > 65535) {
        uiNotificationsStore.showError(t('connections.form.errorPort'));
        return;
    }

    // 编辑时更改了连接类型 (例如 SSH→VNC/RDP)：旧凭证不适用于新协议，必须重新填写
    const typeChangedInEdit = isEditMode.value && !!connectionToEdit.value && connectionToEdit.value.type !== formData.type;
    if (typeChangedInEdit) {
        const missingCredentials =
            (formData.type === 'SSH' && formData.auth_method === 'key' && !formData.selected_ssh_key_id) ||
            (formData.type === 'RDP' && !formData.password) ||
            (formData.type === 'VNC' && !formData.vncPassword);
        if (missingCredentials) {
            uiNotificationsStore.showError(t('uxConn.credentialsRequiredOnTypeChange'));
            return;
        }
    }

    // 跳板机模式下不允许存在未选择的跳板机条目
    if (formData.type === 'SSH' && formData.proxy_type === 'jump' && formData.jump_chain?.some(id => id === null || id === undefined)) {
        uiNotificationsStore.showError(t('uxConn.jumpHostNotSelected'));
        return;
    }

    if (formData.type === 'SSH') {
        if (!isEditMode.value) {
            if (formData.auth_method === 'key' && !formData.selected_ssh_key_id && !formData.host.includes('~')) {
                uiNotificationsStore.showError(t('connections.form.errorSshKeyRequired'));
                return;
            }
        } else {
            if (formData.auth_method === 'key' && !formData.selected_ssh_key_id && connectionToEdit.value?.auth_method !== 'key') {
                 uiNotificationsStore.showError(t('connections.form.errorSshKeyRequiredOnSwitch'));
                 return;
             }
        }
    } else if (formData.type === 'RDP') {
        if (!isEditMode.value && !formData.password && !formData.host.includes('~')) {
            uiNotificationsStore.showError(t('connections.form.errorPasswordRequired'));
            return;
        }
    } else if (formData.type === 'VNC') {
        if (!isEditMode.value && !formData.vncPassword && !formData.host.includes('~')) {
            uiNotificationsStore.showError(t('connections.form.errorVncPasswordRequired', 'VNC 密码是必填项。'));
            return;
        }
    }

    if (!isEditMode.value && formData.host.includes('~')) {
        const parsedIpsResult = parseIpRange(formData.host);

        if (Array.isArray(parsedIpsResult)) {
            const ips = parsedIpsResult;
            if (formData.type === 'SSH' && formData.auth_method === 'key' && !formData.selected_ssh_key_id) {
                uiNotificationsStore.showError(t('connections.form.errorSshKeyRequiredForBatch', '批量添加 SSH (密钥认证) 连接时，必须选择一个 SSH 密钥。'));
                return;
            }
            if (formData.type === 'RDP' && !formData.password) {
                uiNotificationsStore.showError(t('connections.form.errorPasswordRequiredForBatchRDP', '批量添加 RDP 连接时，必须提供密码。'));
                return;
            }
            if (formData.type === 'VNC' && !formData.vncPassword) {
                uiNotificationsStore.showError(t('connections.form.errorPasswordRequiredForBatchVNC', '批量添加 VNC 连接时，必须提供 VNC 密码。'));
                return;
            }

            let successCount = 0;
            let errorCount = 0;
            let firstErrorEncountered: string | null = null;
            const failedIps: string[] = [];

            for (let i = 0; i < ips.length; i++) {
                const currentIp = ips[i];
                const ipSuffix = currentIp.split('.').pop() || `${i + 1}`;
                
                const dataForThisIp: any = {
                    type: formData.type,
                    name: formData.name ? `${formData.name}-${ipSuffix}` : currentIp,
                    host: currentIp,
                    port: formData.port,
                    username: formData.username,
                    notes: formData.notes,
                    proxy_id: formData.proxy_id || null,
                    tag_ids: currentSelectedValidTagIds,
                    proxy_type: formData.proxy_type,
                    jump_chain: getCleanJumpChain(),
                };

                if (formData.type === 'SSH') {
                    dataForThisIp.auth_method = formData.auth_method;
                    if (formData.auth_method === 'password') {
                        dataForThisIp.password = formData.password;
                    } else if (formData.auth_method === 'key') {
                        dataForThisIp.ssh_key_id = formData.selected_ssh_key_id;
                    }
                } else if (formData.type === 'RDP') {
                    dataForThisIp.password = formData.password;
                    delete dataForThisIp.auth_method;
                } else if (formData.type === 'VNC') {
                    dataForThisIp.password = formData.vncPassword;
                    delete dataForThisIp.auth_method;
                }
                
                if (dataForThisIp.type !== 'SSH' || dataForThisIp.auth_method !== 'key') delete dataForThisIp.ssh_key_id;
                if (dataForThisIp.type === 'SSH' && dataForThisIp.auth_method === 'key') delete dataForThisIp.password;
                if (dataForThisIp.type !== 'SSH') delete dataForThisIp.auth_method;

                const success = await connectionsStore.addConnection(dataForThisIp);
                if (success) {
                    successCount++;
                } else {
                    errorCount++;
                    failedIps.push(currentIp);
                    if (!firstErrorEncountered) {
                        firstErrorEncountered = connectionsStore.error || t('errors.unknown', '未知错误');
                    }
                }
            }

            if (errorCount > 0) {
                const MAX_LISTED_IPS = 10;
                const listedIps = failedIps.slice(0, MAX_LISTED_IPS).join(', ') + (failedIps.length > MAX_LISTED_IPS ? ', …' : '');
                const message = t('connections.form.errorBatchAddResult', { successCount, errorCount, firstErrorEncountered: firstErrorEncountered || t('errors.unknown', '未知错误') })
                    + ' ' + t('uxConn.batchFailedIps', { ips: listedIps });
                if (successCount > 0) {
                  uiNotificationsStore.showWarning(message);
                } else {
                  uiNotificationsStore.showError(message);
                }
            } else if (successCount > 0) {
                uiNotificationsStore.showSuccess(t('connections.form.successBatchAddResult', { successCount }));
            }
            // 只要有成功添加的连接就关闭表单并刷新列表，避免再次提交时重复创建已成功的连接
            if (successCount > 0) {
                emit('connection-added');
            }
            return;
        } else if (parsedIpsResult.error && parsedIpsResult.error !== 'not_a_range') {
            uiNotificationsStore.showError(parsedIpsResult.error);
            return;
        }
    }
    
    if (isEditMode.value && formData.host.includes('~')) {
        uiNotificationsStore.showError(t('connections.form.errorIpRangeNotAllowedInEditMode', '编辑模式下不支持 IP 范围。请使用单个 IP 地址。'));
        return;
    }

    const dataToSend: any = {
        type: formData.type,
        name: formData.name,
        host: formData.host.trim(),
        port: formData.port,
        notes: formData.notes,
        username: formData.username,
        proxy_id: formData.proxy_id || null,
        proxy_type: formData.proxy_type,
        tag_ids: currentSelectedValidTagIds,
        jump_chain: getCleanJumpChain(),
    };

    if (formData.type === 'SSH') {
        dataToSend.auth_method = formData.auth_method;
        if (formData.auth_method === 'password') {
            if (formData.password) dataToSend.password = formData.password;
        } else if (formData.auth_method === 'key') {
            if (formData.selected_ssh_key_id) {
                dataToSend.ssh_key_id = formData.selected_ssh_key_id;
            }
        }
    } else if (formData.type === 'RDP') {
        if (formData.password) dataToSend.password = formData.password;
        delete dataToSend.auth_method;
    } else if (formData.type === 'VNC') {
        if (formData.vncPassword) dataToSend.password = formData.vncPassword;
        delete dataToSend.auth_method;
    }
    
    if (dataToSend.type !== 'SSH' || dataToSend.auth_method !== 'key') delete dataToSend.ssh_key_id;
    if (dataToSend.type === 'SSH' && dataToSend.auth_method === 'key') delete dataToSend.password;
    if (dataToSend.type !== 'SSH') delete dataToSend.auth_method;

    let success = false;
    if (isEditMode.value && connectionToEdit.value) {
        success = await connectionsStore.updateConnection(connectionToEdit.value.id, dataToSend);
        if (success) {
            emit('connection-updated');
        } else {
            uiNotificationsStore.showError(t('connections.form.errorUpdate', { error: connectionsStore.error || '未知错误' }));
        }
    } else {
        success = await connectionsStore.addConnection(dataToSend);
        if (success) {
            emit('connection-added');
        } else {
            uiNotificationsStore.showError(t('connections.form.errorAdd', { error: connectionsStore.error || '未知错误' }));
        }
    }
  };

  // 处理删除连接
  const handleDeleteConnection = async () => {
    if (!isEditMode.value || !connectionToEdit.value) return;

    const connectionName = connectionToEdit.value.name || `ID: ${connectionToEdit.value.id}`;
    const confirmedDeleteConnection = await showConfirmDialog({
      message: t('connections.prompts.confirmDelete', { name: connectionName })
    });
    if (!confirmedDeleteConnection) {
        return;
    }

    formError.value = null;
    connectionsStore.error = null;

    const success = await connectionsStore.deleteConnection(connectionToEdit.value.id);
    if (success) {
      emit('connection-deleted');
      emit('close');
    } else {
      uiNotificationsStore.showError(t('connections.form.errorDelete', { error: connectionsStore.error || t('errors.unknown', '未知错误') }));
    }
  };

  // --- Tag Creation/Deletion Handling ---
  const handleCreateTag = async (tagName: string) => {
      if (!tagName || tagName.trim().length === 0) return;
      const newTag = await tagsStore.addTag(tagName.trim());
      if (newTag && !formData.tag_ids.includes(newTag.id)) {
          formData.tag_ids.push(newTag.id);
      }
  };

  const handleDeleteTag = async (tagId: number) => {
      const tagToDelete = tags.value.find(t_ => t_.id === tagId);
      if (!tagToDelete) return;

      const confirmedDeleteTag = await showConfirmDialog({
        message: t('tags.prompts.confirmDelete', { name: tagToDelete.name })
      });
      if (confirmedDeleteTag) {
          const success = await tagsStore.deleteTag(tagId);
          if (!success) {
              showAlertDialog({ title: t('common.error', '错误'), message: t('tags.errorDelete', { error: tagsStore.error || '未知错误' }) });
          }
      }
  };

  // 处理测试连接
  let testAbortController: AbortController | null = null;

  // 编辑模式下：表单中与连接测试相关的字段是否与已保存的配置不同
  const hasUnsavedTestChanges = (): boolean => {
    const saved = connectionToEdit.value;
    if (!saved) return true;
    const savedJumpChain = (saved.jump_chain ?? []).filter((id): id is number => typeof id === 'number');
    const formJumpChain = getCleanJumpChain() ?? [];
    return (
      saved.type !== formData.type ||
      saved.host !== formData.host.trim() ||
      saved.port !== formData.port ||
      saved.username !== formData.username ||
      saved.auth_method !== formData.auth_method ||
      !!formData.password ||
      (formData.auth_method === 'key' && (saved.ssh_key_id ?? null) !== (formData.selected_ssh_key_id ?? null)) ||
      (saved.proxy_type ?? null) !== (formData.proxy_type ?? null) ||
      (formData.proxy_type === 'proxy' && (saved.proxy_id ?? null) !== (formData.proxy_id ?? null)) ||
      (formData.proxy_type === 'jump' && JSON.stringify(savedJumpChain) !== JSON.stringify(formJumpChain))
    );
  };

  const cancelTestConnection = () => {
    if (testAbortController) {
      testAbortController.abort();
      testAbortController = null;
    }
    if (testStatus.value === 'testing') {
      testStatus.value = 'idle';
      testResult.value = null;
      testLatency.value = null;
    }
  };

  onBeforeUnmount(() => {
    cancelTestConnection();
  });

  const handleTestConnection = async () => {
    cancelTestConnection();
    const abortController = new AbortController();
    testAbortController = abortController;
    testStatus.value = 'testing';
    testResult.value = null;
    testLatency.value = null;

    try {
      if (formData.type === 'SSH' && formData.proxy_type === 'jump' && formData.jump_chain?.some(id => id === null || id === undefined)) {
        throw new Error(t('uxConn.jumpHostNotSelected'));
      }

      const jumpChain = formData.proxy_type === 'jump' ? getCleanJumpChain() : null;
      const useProxy = formData.proxy_type === 'proxy' && !!formData.proxy_id;
      // 后端每一跳 (代理握手 / 每个跳板机 / 目标主机) 各有独立超时，请求超时需覆盖整条链
      const hops = 1 + (jumpChain?.length ?? 0) + (useProxy ? 1 : 0);
      const requestConfig = {
        timeout: BACKEND_TEST_TIMEOUT_PER_HOP_MS * hops + TEST_REQUEST_TIMEOUT_MARGIN_MS,
        signal: abortController.signal,
      };

      let response;
      const savedConnection = isEditMode.value ? connectionToEdit.value : null;
      if (savedConnection && !hasUnsavedTestChanges()) {
        response = await apiClient.post(`/connections/${savedConnection.id}/test`, undefined, requestConfig);
      } else {
        const dataToSend: Record<string, any> = {
            host: formData.host.trim(),
            port: formData.port,
            username: formData.username,
            auth_method: formData.auth_method,
            password: formData.auth_method === 'password' ? formData.password : undefined,
            proxy_id: useProxy ? formData.proxy_id : null,
            proxy_type: formData.proxy_type,
            jump_chain: jumpChain,
            ssh_key_id: formData.auth_method === 'key' ? formData.selected_ssh_key_id : undefined,
        };
        // 编辑模式：未填写的凭证由后端从已保存的连接补全 (仅当类型与认证方式均未变化时)
        const canReuseSavedCredentials = !!savedConnection && savedConnection.type === 'SSH' && savedConnection.auth_method === formData.auth_method;
        if (savedConnection && savedConnection.type === 'SSH') {
          dataToSend.connectionId = savedConnection.id;
        }

        if (!dataToSend.host || !dataToSend.port || !dataToSend.username || !dataToSend.auth_method) {
          throw new Error(t('connections.test.errorMissingFields'));
        }
        if (dataToSend.auth_method === 'key' && !dataToSend.ssh_key_id && !canReuseSavedCredentials) {
          throw new Error(t('connections.form.errorSshKeyRequired'));
        }
        response = await apiClient.post('/connections/test-unsaved', dataToSend, requestConfig);
      }

      if (testAbortController !== abortController) return; // 已取消或被新的测试取代

      if (response.data.success) {
        testStatus.value = 'success';
        testLatency.value = response.data.latency;
        testResult.value = `${response.data.latency} ms`;
      } else {
        testStatus.value = 'error';
        const errorMessage = response.data.message || t('connections.test.errorUnknown');
        testResult.value = errorMessage;
        uiNotificationsStore.showError(errorMessage);
      }

    } catch (error: any) {
      if (isCancel(error) || testAbortController !== abortController) {
        return; // 用户取消测试：不显示错误
      }
      console.error('测试连接失败:', error);
      testStatus.value = 'error';
      let errorMessageToShow: string;
      if (error.response && error.response.data && error.response.data.message) {
        errorMessageToShow = error.response.data.message;
      } else if (error.code === 'ECONNABORTED') {
        errorMessageToShow = t('uxConn.testTimedOut');
      } else {
        errorMessageToShow = error.message || t('connections.test.errorNetwork');
      }
      testResult.value = errorMessageToShow;
      uiNotificationsStore.showError(errorMessageToShow);
    } finally {
      if (testAbortController === abortController) {
        testAbortController = null;
      }
    }
  };

  // 计算延迟颜色
  const latencyColor = computed(() => {
    if (testStatus.value !== 'success' || testLatency.value === null) {
      return 'inherit';
    }
    const latency = testLatency.value;
    if (latency < 100) return 'var(--color-success, #28a745)';
    if (latency < 500) return 'var(--color-warning, #ffc107)';
    return 'var(--color-danger, #dc3545)';
  });

  // 计算测试按钮文本
  const testButtonText = computed(() => {
      if (testStatus.value === 'testing') {
          return t('connections.form.testing');
      }
      return t('connections.form.testConnection');
  });

  // --- Jump Host Chain Management ---
  const addJumpHost = () => {
    if (formData.jump_chain === null || formData.jump_chain === undefined) {
      formData.jump_chain = [];
    }
    formData.jump_chain.push(null);
  };

  const removeJumpHost = (index: number) => {
    if (formData.jump_chain && index >= 0 && index < formData.jump_chain.length) {
      formData.jump_chain.splice(index, 1);
    }
  };

  return {
    formData,
    isLoading,
    testStatus,
    testResult,
    testLatency,
    isScriptModeActive,
    scriptInputText,
    isEditMode,
    formTitle,
    submitButtonText,
    proxies, // for <select>
    tags,    // for <TagInput :available-tags="tags">
    isProxyLoading,
    proxyStoreError,
    isTagLoading,
    tagStoreError,
    handleSubmit,
    handleDeleteConnection,
    handleTestConnection,
    cancelTestConnection,
    handleCreateTag,
    handleDeleteTag,
    latencyColor,
    testButtonText,
    advancedConnectionMode, 
    addJumpHost,         
    removeJumpHost,         
    connections,
  };
}