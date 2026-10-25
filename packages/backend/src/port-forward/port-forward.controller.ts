import { Request, Response } from 'express';
import * as repo from './port-forward.repository';
import * as service from './port-forward.service';
import { PortForwardRuleInput } from './port-forward.repository';
import * as ConnectionRepository from '../connections/connection.repository';

const isValidPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
// 主机名 / IPv4 / IPv6（可带方括号）；拒绝空白和控制字符，避免奇怪的值进到 listen / forwardOut
const HOST_RE = /^[A-Za-z0-9._:\-\[\]%]{1,253}$/;

const normalizeHost = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

export const sanitizeRuleInput = (body: any): PortForwardRuleInput => {
    const type = body?.type;
    if (type !== 'local' && type !== 'remote' && type !== 'dynamic') {
        throw new Error('type 只能是 local / remote / dynamic');
    }
    const bindPort = Number(body?.bind_port);
    if (!isValidPort(bindPort)) throw new Error('监听端口不合法');
    const bindHost = normalizeHost(body?.bind_host) || '127.0.0.1';
    if (!HOST_RE.test(bindHost)) throw new Error('监听地址不合法');

    if (type === 'dynamic') {
        return { type, bind_host: bindHost, bind_port: bindPort, target_host: null, target_port: null, auto_start: !!body?.auto_start };
    }

    const targetPort = Number(body?.target_port);
    const targetHost = normalizeHost(body?.target_host);
    if (!targetHost) throw new Error('目标地址不能为空');
    if (!HOST_RE.test(targetHost)) throw new Error('目标地址不合法');
    if (!isValidPort(targetPort)) throw new Error('目标端口不合法');
    return {
        type,
        bind_host: bindHost,
        bind_port: bindPort,
        target_host: targetHost,
        target_port: targetPort,
        auto_start: !!body?.auto_start,
    };
};

const parseConnectionId = (raw: unknown): number | null => {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const parseRuleId = (req: Request, res: Response): number | null => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ message: '规则 ID 不合法' });
        return null;
    }
    return id;
};

/** GET /port-forwards?connectionId=1 —— 规则 + 运行状态 */
export const list = async (req: Request, res: Response): Promise<void> => {
    const connectionId = parseConnectionId(req.query.connectionId);
    if (!connectionId) {
        res.status(400).json({ message: 'connectionId 不合法' });
        return;
    }
    try {
        const rules = await repo.listRulesByConnection(connectionId);
        res.json({ rules, statuses: service.getStatuses(rules) });
    } catch (err: any) {
        res.status(500).json({ message: err.message });
    }
};

export const create = async (req: Request, res: Response): Promise<void> => {
    const connectionId = parseConnectionId(req.query.connectionId ?? req.body?.connection_id);
    if (!connectionId) {
        res.status(400).json({ message: 'connectionId 不合法' });
        return;
    }
    try {
        const conn = await ConnectionRepository.findConnectionByIdWithTags(connectionId);
        if (!conn) {
            res.status(404).json({ message: '连接不存在' });
            return;
        }
        if ((conn as any).type && (conn as any).type !== 'SSH') {
            res.status(400).json({ message: '只有 SSH 连接支持端口转发' });
            return;
        }
        const rule = await repo.createRule(connectionId, sanitizeRuleInput(req.body));
        if (rule.auto_start) {
            await service.startRule(rule).catch(() => { /* 启动失败的原因在状态里能看到 */ });
        }
        res.status(201).json(rule);
    } catch (err: any) {
        res.status(400).json({ message: err.message });
    }
};

export const update = async (req: Request, res: Response): Promise<void> => {
    const id = parseRuleId(req, res);
    if (!id) return;
    const existing = await repo.getRuleById(id);
    if (!existing) {
        res.status(404).json({ message: '规则不存在' });
        return;
    }
    try {
        const input = sanitizeRuleInput(req.body);
        // 改了参数就得重启，否则监听还挂在旧端口上；原本在跑的，改完继续跑
        const wasRunning = service.getStatuses([existing])[0]?.running === true;
        await service.stopRule(id, true).catch(() => { /* ignore */ });
        const rule = await repo.updateRule(id, input);
        if (rule && (wasRunning || rule.auto_start)) {
            await service.startRule(rule).catch(() => { /* 状态里可查 */ });
        }
        res.json(rule);
    } catch (err: any) {
        res.status(400).json({ message: err.message });
    }
};

export const remove = async (req: Request, res: Response): Promise<void> => {
    const id = parseRuleId(req, res);
    if (!id) return;
    await service.stopRule(id, true).catch(() => { /* ignore */ });
    await repo.deleteRule(id);
    res.status(204).end();
};

export const start = async (req: Request, res: Response): Promise<void> => {
    const id = parseRuleId(req, res);
    if (!id) return;
    const rule = await repo.getRuleById(id);
    if (!rule) {
        res.status(404).json({ message: '规则不存在' });
        return;
    }
    try {
        const status = await service.startRule({ ...rule, auto_start: 1 });
        // 启动成功才记住"下次自动恢复"，失败的规则不该在每次开机时反复重试
        await repo.setAutoStart(id, true);
        res.json(status);
    } catch (err: any) {
        res.status(502).json({ message: err.message, ruleId: id });
    }
};

export const stop = async (req: Request, res: Response): Promise<void> => {
    const id = parseRuleId(req, res);
    if (!id) return;
    await repo.setAutoStart(id, false);
    await service.stopRule(id, true);
    service.clearLastError(id);
    res.json({ ruleId: id, running: false });
};

/** GET /port-forwards/status?connectionId=1 —— 只取运行态（前端轮询用） */
export const status = async (req: Request, res: Response): Promise<void> => {
    const connectionId = parseConnectionId(req.query.connectionId);
    if (!connectionId) {
        res.status(400).json({ message: 'connectionId 不合法' });
        return;
    }
    const rules = await repo.listRulesByConnection(connectionId);
    res.json({ statuses: service.getStatuses(rules) });
};
