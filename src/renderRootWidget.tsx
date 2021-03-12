import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { IoConf, newTrace } from '@rotcare/io';
import { UiScene, WidgetClass } from '@rotcare/rx-core';
import { runInSpan } from './tracing';
import { Suspense } from 'react';
import { renderWidget } from './renderWidget';

export function renderRootWidget(
    widgetClass: WidgetClass,
    ioConf: IoConf,
) {
    UiScene.ioConf = ioConf;
    const elem = document.getElementById('RootWidget');
    if (!elem) {
        console.error('missing element #RootWidget');
        return;
    }
    const operation = newTrace(`initial render ${window.location.href}`);
    runInSpan(operation, () => {
        ReactDOM.render(
            <Suspense fallback={<span>WARNING: promise thrown to root</span>}>{renderWidget(widgetClass as any)}</Suspense>,
            elem,
        );
    });
}