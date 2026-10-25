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
import { parseScriptText, type ParsedScriptRow } from '../utils/scriptConnectionParser';
// OpenSSH 命令规范化（ssh -p 2222 user@host / -l / -i / ssh:// / 尾随 -name -tags -note）已移入解析器模块，此处转出保持原入口
export { normalizeOpenSshCommand } from '../utils/scriptConnectionParser';

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

  /**
   * 脚本批量导入提交（移植自上游 93fc9d79 的提交流程，解析规则保持本分支原有语法）。
   * 解析见 utils/scriptConnectionParser：OpenSSH 命令规范化（normalizeOpenSshCommand）、
   * SSH 无 -p/-k 按空密码、注释行、-folder 别名、-jump 跳板机链、IP 范围展开。
   * 有错误行时先确认「跳过 N 行、继续导入 M 个」，文件夹按名字懒建且一次批量只建一次。
   */
  const scriptErrorText = (row: ParsedScriptRow) =>
    row.error ? t(row.error.key, row.error.params ?? {}) : '';

  const handleScriptModeSubmit = async () => {
    const result = parseScriptText(scriptInputText.value);
    const connectionsToAdd = result.validConnections;

    if (connectionsToAdd.length === 0) {
      if (result.errorRows.length > 0) {
        const first = result.errorRows[0];
        uiNotificationsStore.showError(t('connections.form.scriptErrorInLineNumber', { line: first.lineIndex, error: scriptErrorText(first) }));
      } else {
        uiNotificationsStore.showError(t('connections.form.scriptModeEmpty', '脚本输入不能为空。'));
      }
      return;
    }

    if (result.errorRows.length > 0) {
      const first = result.errorRows[0];
      const proceed = await showConfirmDialog({
        message: t('connections.form.scriptConfirmSkipErrors', {
          errors: result.errorRows.length,
          line: first.lineIndex,
          error: scriptErrorText(first),
          ok: connectionsToAdd.length,
        }),
      });
      if (!proceed) return;
    }

    // --- 名字 → id 解析（文件夹懒建并缓存，密钥 / 代理 / 跳板机找不到时明确报错并中止） ---
    const folderIdCache = new Map<string, number>();
    const resolveFolderId = async (folderName: string): Promise<number | null> => {
      if (folderIdCache.has(folderName)) return folderIdCache.get(folderName)!;
      let found = tags.value.find(tag => tag.name === folderName);
      if (!found) {
        const created = await tagsStore.addTag(folderName);
        if (!created) {
          uiNotificationsStore.showError(t('connections.form.scriptErrorTagCreationFailed', { tagName: folderName }));
          return null;
        }
        found = created;
        uiNotificationsStore.showInfo(t('connections.form.scriptTagCreated', { tagName: folderName }));
      }
      folderIdCache.set(folderName, found.id);
      return found.id;
    };

    const payloads: any[] = [];
    for (const item of connectionsToAdd) {
      const data: any = {
        type: item.type,
        name: item.name,
        host: item.host,
        port: item.port,
        username: item.username,
        notes: item.note || '',
        tag_ids: [] as number[],
      };

      for (const folderName of item.tags) {
        const id = await resolveFolderId(folderName);
        if (id === null) return;
        if (!data.tag_ids.includes(id)) data.tag_ids.push(id);
      }

      if (item.type === 'SSH') {
        if (item.keyName) {
          const foundKey = sshKeys.value.find(k => k.name === item.keyName);
          if (!foundKey) {
            uiNotificationsStore.showError(t('connections.form.scriptErrorSshKeyNotFound', { keyName: item.keyName }));
            return;
          }
          data.auth_method = 'key';
          data.ssh_key_id = foundKey.id;
        } else {
          data.auth_method = 'password';
          data.password = item.password ?? '';
        }
      } else {
        data.password = item.password;
      }

      if (item.proxyName) {
        const foundProxy = proxies.value.find(p => p.name === item.proxyName);
        if (!foundProxy) {
          uiNotificationsStore.showError(t('proxies.errors.notFound', { name: item.proxyName }));
          return;
        }
        data.proxy_id = foundProxy.id;
      }

      if (item.jumpNames.length) {
        const chain: number[] = [];
        for (const jumpName of item.jumpNames) {
          const jumpConn = connections.value.find(c => c.name === jumpName && c.type === 'SSH');
          if (!jumpConn) {
            uiNotificationsStore.showError(t('connections.form.scriptErrorJumpNotFound', { name: jumpName }));
            return;
          }
          chain.push(jumpConn.id);
        }
        data.proxy_type = 'jump';
        data.proxy_id = null;
        data.jump_chain = chain;
      }

      payloads.push(data);
    }

    uiNotificationsStore.showInfo(t('connections.form.scriptModeAddingConnections', { count: payloads.length }));

    let successCount = 0;
    let errorCount = 0;
    let firstErrorEncountered: string | null = null;

    for (const finalConnectionData of payloads) {
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

    if (folderIdCache.size > 0) {
      await tagsStore.fetchTags();
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
      if (errorCount === 0 && result.errorRows.length === 0) {
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