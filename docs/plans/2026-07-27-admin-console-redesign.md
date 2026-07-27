# Admin Console Redesign

## Goal

Turn the current long, card-heavy admin page into a quiet operations console that is faster to scan and keeps synchronous and asynchronous workflows clearly separated.

## Information Architecture

The desktop layout uses a persistent left navigation rail. On narrow screens the same navigation becomes a compact top grid. The five views are:

1. `运行总览`: combined health signals for the synchronous service and asynchronous task system.
2. `同步接口`: generation concurrency, image processing, memory, latency trend, errors, and request audit.
3. `异步任务`: task backlog, callbacks, node capacity, worker instances, image tasks, and callback events.
4. `图片记录`: successful generated/uploaded image records.
5. `系统工具`: drain mode and manual R2 upload.

The top bar contains only the current view title, automatic refresh interval, manual refresh, and logout.

## Node Presentation

Worker nodes are rendered as compact operational rows rather than large nested cards. Node ID and advertised IP remain primary. Capacity, active task count, success/failure counters, and memory are shown as a four-column metric strip. Container hostname, PID, container IP, and per-instance memory remain available under a native collapsible diagnostic section.

Each node renders at most three current tasks. The heartbeat and admin API continue reporting the accurate total active count. When more than three tasks are active, the UI displays `另有 N 个任务正在运行` and links to the task table. This limits page height without hiding the load signal.

## Compatibility

No backend endpoint, public image task response, callback payload, scheduler behavior, or deployment variable changes. Existing admin API data is reorganized in the React view only.

## Verification

- Production admin and TypeScript builds.
- Existing automated test suite.
- Populated desktop checks at 1440px.
- Responsive checks at 1024px, 768px, 390px, and 375px.
- Navigation, collapsible instance diagnostics, task overflow summary, table scrolling, keyboard focus, light/dark mode, and browser console checks.
