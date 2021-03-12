import { useLog } from '@rotcare/io';
import { Future, reactive, Widget, WidgetClass, WidgetSpi } from '@rotcare/rx-core';
import * as React from 'react';
import { currentSpan, runInSpan } from './tracing';

export const REALM_REACT = Symbol();
const log = useLog(REALM_REACT);

const comps = new Map<WidgetClass<any>, Function>();

export function renderWidget<T extends Widget>(
    widgetClass: WidgetClass<T>,
    props?: T['props'],
): React.ReactElement;
export function renderWidget<T extends Widget>(widget: Widget): React.ReactElement;
export function renderWidget<T extends Widget>(arg1: WidgetClass<T> | Widget, props?: T['props']) {
    let widgetClass: WidgetClass;
    if (arg1 instanceof Widget) {
        widgetClass = arg1.constructor as any;
        props = { __borrowed__: arg1 } as any;
    } else {
        widgetClass = arg1;
    }
    let Component = comps.get(widgetClass);
    if (!Component) {
        Component = React.memo(reactComponent.bind(undefined, widgetClass));
        comps.set(widgetClass, Component);
    }
    return <Component {...props} />;
}

// 以下是 react 的黑魔法，看不懂是正常的
// 实际交给 react 执行的组件是下面这个函数，它屏蔽了异步 I/O，使得 widget.render 只需要处理同步的渲染
export function reactComponent(widgetClass: WidgetClass, props: Record<string, any>) {
    return log.execute('render reactComponent', () => {
        // 我们没有把状态存在 react 的体系内，而是完全外置的状态
        // 并不打算支持 react concurrent，也绝对会有 tearing 的问题，don't care
        // 目标就是业务代码中完全没有 useState 和 useContext，全部用 scene 获取的状态代替
        // 外部状态改变的时候，触发 forceRender，重新渲染一遍 UI
        const [isForceRender, forceRender] = React.useState(0);
        log`isForceRender: ${isForceRender}`;
        // 创建 widget，仅会在首次渲染时执行一次
        const [{ widget, initialRenderSpan }, _] = React.useState(() => {
            const widget: WidgetSpi = props.__borrowed__ || new widgetClass(props as any);
            for (const [k, v] of Object.entries(widget)) {
                if (v && v instanceof Future) {
                    widget.asyncDeps.set(k, v);
                }
            }
            widget.onAtomChanged = (op) => {
                log`notifyChange ${widget}, unmounted: ${widget.unmounted}`;
                if (!widget.unmounted) {
                    runInSpan(op, () => {
                        forceRender((count) => count + 1);
                    });
                }
            };
            log`inited widget instance with ${widget.asyncDeps.size} futures`;
            return { widget, initialRenderSpan: currentSpan() };
        });
        log`widget: ${widget}`;
        const [isReady, setReady] = React.useState<false | true | Promise<void>>(
            !widget.needMountAsync,
        );
        log`isReady: ${isReady}`;
        // 无论是否要渲染，setupHooks 都必须执行，react 要求 hooks 数量永远不变
        const hooks = widget.setupHooks();
        React.useEffect(
            log.wrap('mount reactComponent', () => {
                log`widget: ${widget}`;
                // mount 之后触发外部状态的获取
                if (widget.unmounted) {
                    widget.unmounted = false;
                    log`reset widget unmounted flag`;
                }
                log`needMountAsync: ${widget.needMountAsync}`;
                if (widget.needMountAsync) {
                    const promise = (async () => {
                        try {
                            await widget.mount(initialRenderSpan);
                            // 如果数据获取成功则开始真正渲染
                            if (!widget.unmounted) {
                                runInSpan(initialRenderSpan, () => {
                                    setReady(true);
                                });
                            }
                        } catch (e) {
                            // 否则把异常设置到 state 里，下面 throw isReady 的时候抛给父组件
                            runInSpan(initialRenderSpan, () => {
                                setReady(e);
                            });
                        }
                    })();
                    setReady(promise);
                }
                // 此处返回的回调会在 unmount 的时候调用
                return log.wrap('unmount reactComponent', () => {
                    log`widget: ${widget}`;
                    widget.unmount();
                });
            }),
            [],
        ); // [] 表示该 Effect 仅执行一次，也就是 mount/unmount
        // react 组件处于 false => 初始化中 => true 三种状态之一
        if (isReady === true) {
            if (isForceRender) {
                // isReady 了之后，后续的重渲染都是因为外部状态改变而触发的，所以要刷一下
                widget.refreshAsyncDeps(currentSpan(), false);
                // 刷新是异步的，刷新完成了之后会再次重渲染 react 组件重新走到这里
                // refreshSubscriptions 内部会判重，不会死循环
            }
            reactive.currentChangeTracker = {
                onAtomRead: (atom) => {
                    atom.addSubscriber(widget);
                    widget.syncDeps.add(atom);
                },
                onAtomChanged: (atom) => {
                    throw new Error(`render should be readonly, but modified: ${atom}`);
                },
            };
            try {
                return widget.attachTo(reactive.currentChangeTracker).render(hooks);
            } finally {
                reactive.currentChangeTracker = undefined;
            }
        } else if (isReady === false) {
            // 第一次不能直接 throw promise，否则 react 会把所有 state 给扔了，只能渲染个空白出去
            return <></>;
        } else {
            // 把 loading 或者 loadFailed 往父组件抛，被 <Suspense> 或者 <ErrorBoundary> 给抓住
            throw isReady;
        }
    });
}