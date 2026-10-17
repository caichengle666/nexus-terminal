declare module 'proxy-addr' {
    import { IncomingMessage } from 'http';
    type TrustFn = (addr: string, index: number) => boolean;
    function proxyaddr(req: IncomingMessage, trust: TrustFn | string | string[]): string;
    namespace proxyaddr {
        function all(req: IncomingMessage, trust?: TrustFn | string | string[]): string[];
        function compile(val: string | string[]): TrustFn;
    }
    export = proxyaddr;
}
