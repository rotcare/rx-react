import { Span } from "@rotcare/io";
import * as tracing from 'scheduler/tracing';

export function runInSpan<T>(op: Span, action: () => T): T {
    // 这个就是 react 的异步调用链传递机制
    // 否则组件被 render 了不能知道是被什么 operation 给触发的
    return tracing.unstable_trace(op as any, 0, () => {
        return action();
    });
}

export function currentSpan(): Span {
    const interactions = tracing.unstable_getCurrent();
    if (!interactions) {
        throw new Error('missing span');
    }
    for (const interaction of interactions) {
        const maybeOp = interaction.name as any;
        if (maybeOp && maybeOp.traceId) {
            return maybeOp;
        }
    }
    throw new Error('missing span');
}