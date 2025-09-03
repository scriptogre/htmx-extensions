/*
  Server Commands Extension (using <htmx> tags)
  ======================================================
  This extension enables server-driven UI updates using custom <htmx> elements
  in a server response. It allows a single response to contain multiple
  commands for swapping content, triggering events, and managing browser history.
*/
(function () {
    /** @type {import("../htmx").HtmxInternalApi} */
    let api;

    // <htmx> tag valid attributes
    const VALID_COMMAND_ATTRIBUTES = new Set([
        'target',
        'swap',
        'select',
        'redirect',
        'refresh',
        'location',
        'push-url',
        'replace-url',
        'trigger',
        'trigger-after-swap',
        'trigger-after-settle',
    ]);

    htmx.defineExtension('server-commands', {
        /** @param {import("../htmx").HtmxInternalApi} apiRef */
        init: function (apiRef) {
            api = apiRef;
        },

        /** @param {string} text, @param {XMLHttpRequest} xhr, @param {Element} elt */
        transformResponse: function (text, xhr, elt) {
            // Check if empty text, or no <htmx> tags
            const fragment = text ? api.makeFragment(text) : null;
            if (!fragment || !fragment.querySelector('htmx')) {
                return text; // Return early
            }

            const settleInfo = api.makeSettleInfo(elt);

            // Find all <htmx> tags
            const allCommandElements = fragment.querySelectorAll('htmx');

            // Keep only top-level ones (direct children of the fragment)
            const topLevelCommandElements = Array.from(allCommandElements).filter(el => {
                // Check if this htmx element is a direct child of the fragment
                return el.parentNode === fragment;
            });

            if (allCommandElements.length > topLevelCommandElements.length) {
                console.warn(
                    '[server-commands] Nested <htmx> command tags are not supported and will be discarded.',
                    { triggeringElement: elt }
                );
            }

            // Process ONLY the top-level <htmx> tags in order
            (async () => {
                for (const el of topLevelCommandElements) {
                    await processCommandFromElement(el, elt, settleInfo);
                }
            })();

            // Remove all <htmx> tags from the fragment
            allCommandElements.forEach(el => el.remove());

            // Serialize remaining nodes into an HTML string
            const container = document.createElement('div');
            container.appendChild(fragment);

            return container.innerHTML;
        },

// handleSwap: function (swapStyle, target, fragment, settleInfo) {
//     return false;
//             // Check for our custom flag and the htmx config setting
//             if (settleInfo.isCommandsOnly) {
//                 if (!htmx.config.preserveSourceElementOnOnlyCommands) {
//                     console.warn(
//                         `[server-commands] Response has ${commandElements.length} <htmx> command tag(s) but no main content to swap. This causes an empty swap, which removes the triggering element from the page.
//
// To prevent this:
//   • Add hx-swap="none" to your element if you only want to run commands without a swap.
//   • To allow this behavior globally, add this meta tag to your page's <head>:
//     <meta name="htmx-config" content='{"preserveSourceElementOnCommandsOnly": true}'>`,
//                         { triggeringElement: elt }
//                     );
//                 } else {
//                     // By returning an empty array, we tell htmx the swap is
//                     // "handled" and that zero elements were settled.
//                     // This cleanly and safely cancels the swap.
//                     return [];
//                 }
//             }
//
//             // If the flag is not set, return false to let htmx
//             // perform its regular swap operation.
//             return false;
//         }
    });



    /**
     * Processes a single <htmx> element by reading its attributes and executing
     * actions in a fixed, sequential order.
     * @param {HTMLElement} commandElt
     * @param {Element} contextElt
     * @param {HtmxSettleInfo} settleInfo
     */
    async function processCommandFromElement(commandElt, contextElt, settleInfo) {
        try {
            // Fire a cancelable event for this specific tag.
            if (api.triggerEvent(contextElt, 'htmx:beforeServerCommand', {
                commandElement: commandElt,
                context: contextElt
            }) === false) {
                return; // Stop processing
            }

            // --- VALIDATION ---
            validateCommandElement(commandElt);

            // --- STEP 1: GATHER SWAP JOBS ---
            const swapJobs = [];
            const commandSwapStyle = api.getAttributeValue(commandElt, 'swap') || 'outerHTML';
            const commandSelect = api.getAttributeValue(commandElt, 'select');
            const commandTargetSelector = api.getAttributeValue(commandElt, 'target');

            if (commandTargetSelector) {
                // Explicit target (e.g. <htmx target="#explicit">...</htmx>)
                const commandTargetEl = htmx.find(commandTargetSelector);
                if (commandTargetEl) {
                    swapJobs.push({ targetEl: commandTargetEl, content: commandElt.innerHTML });
                } else {
                    const error = new Error(`[server-commands] The target selector "${commandTargetSelector}" did not match any elements.`);
                    api.triggerErrorEvent(contextElt, 'htmx:targetError', { error: error, target: commandTargetSelector });
                }
            }
            // Note: validateCommandElement() already checks for missing target attribute

            // --- STEP 2: PROCESS SWAP JOBS & FIRE EVENTS ---
            const swapPromises = [];
            const swapSpec = api.getSwapSpecification(contextElt, commandSwapStyle);  // Ensures modifiers work
            for (const job of swapJobs) {
                const beforeSwapDetails = {
                    elt: contextElt,
                    target: job.targetEl,
                    swapSpec: swapSpec,
                    serverResponse: job.content,
                    shouldSwap: true,
                    fromServerCommand: true
                };

                if (api.triggerEvent(job.targetEl, 'htmx:beforeSwap', beforeSwapDetails) === false) {
                    continue; // Skip this job if a listener cancelled it
                }

                if (beforeSwapDetails.shouldSwap) {
                    swapPromises.push(swapAsync(
                        beforeSwapDetails.target,
                        beforeSwapDetails.serverResponse,
                        beforeSwapDetails.swapSpec,
                        { select: commandSelect, eventInfo: { elt: contextElt }, contextElement: contextElt },
                        settleInfo
                    ));
                }
            }

            // --- STEP 2: WAIT FOR SWAP DOM MANIPULATION TO COMPLETE ---
            const settlePromises = await Promise.all(swapPromises);

            api.triggerEvent(contextElt, 'htmx:afterSwap', {commandElement: commandElt});

            // --- STEP 3: DO AFTER-SWAP TRIGGERS ---
            if (commandElt.hasAttribute('trigger-after-swap')) {
                handleTriggerAttribute({value: commandElt.getAttribute('trigger-after-swap')});
            }

            // --- STEP 4: WAIT FOR ALL SETTLING TO FINISH ---
            await Promise.all(settlePromises.flat());

            // --- STEP 5: DO AFTER-SETTLE TRIGGERS ---
            if (commandElt.hasAttribute('trigger-after-settle')) {
                handleTriggerAttribute({value: commandElt.getAttribute('trigger-after-settle')});
            }

            // --- STEP 6: DO IMMEDIATE TRIGGERS & SERVER COMMANDS ---
            if (commandElt.hasAttribute('trigger')) {
                handleTriggerAttribute({value: commandElt.getAttribute('trigger')});
            }
            if (commandElt.hasAttribute('location')) {
                handleLocationAttribute(commandElt.getAttribute('location'), contextElt);
            }
            if (commandElt.hasAttribute('redirect')) {
                window.location.href = commandElt.getAttribute('redirect');
                return; // Stop processing
            }
            if (commandElt.hasAttribute('refresh') && commandElt.getAttribute('refresh') !== 'false') {
                window.location.reload();
                return; // Stop processing
            }
            if (commandElt.hasAttribute('push-url')) {
                saveCurrentPageToHistory();
                pushUrlIntoHistory(commandElt.getAttribute('push-url'));
            }
            if (commandElt.hasAttribute('replace-url')) {
                saveCurrentPageToHistory();
                replaceUrlInHistory(commandElt.getAttribute('replace-url'));
            }

            api.triggerEvent(contextElt, 'htmx:afterServerCommand', {commandElement: commandElt});

        } catch (error) {
            // Fire the public event for programmatic listeners.
            api.triggerErrorEvent(
                document.body, 'htmx:serverCommandError', {error: error, commandElement: commandElt}
            );
        }
    }

    /**
     * Validate <htmx> element & throw an error for unknown attributes or invalid combinations.
     * @param {HTMLElement} element
     */
    function validateCommandElement(element) {
        const errors = [];

        const hasCommandAttribute = Array.from(element.attributes).some(attr => VALID_COMMAND_ATTRIBUTES.has(attr.name));
        if (!hasCommandAttribute) {
            const elementHTML = element.outerHTML.replace(/\s*\n\s*/g, " ").trim();
            throw new Error(`[server-commands] The following <htmx> tag has no command attributes and is therefore invalid:\n\n  ${elementHTML}\n`);
        }

        // Check unknown attributes
        for (const attr of element.attributes) {
            if (!VALID_COMMAND_ATTRIBUTES.has(attr.name)) {
                errors.push(
                    `Invalid attribute '${attr.name}'. Valid attributes are: ${[...VALID_COMMAND_ATTRIBUTES].join(', ')}`
                );
            }
        }

        // Check invalid combinations
        const hasSwapOrSelect = element.hasAttribute('swap') || element.hasAttribute('select');
        const hasTarget = element.hasAttribute('target');
        if (hasSwapOrSelect && !hasTarget) {
            errors.push(
                `A command with 'swap' or 'select' performs a swap and requires a target. Specify the target using the 'target' attribute: <htmx target="#my-div">...</htmx>`
            );
        }

        // If errors were found, throw an error with details
        if (errors.length > 0) {
            const elementHTML = element.outerHTML.replace(/\s*\n\s*/g, " ").trim();
            const errorIntro = `[server-commands] ${errors.length} validation error(s) for command:`;
            const errorDetails = errors.map(e => `  - ${e}`).join('\n');

            throw new Error(`${errorIntro}\n\n  ${elementHTML}\n\n${errorDetails}\n`);
        }
    }

    /**
     * Executes a trigger value (JSON or comma-separated events).
     * @param {{value: string, timing: string}} trigger
     */
    function handleTriggerAttribute(trigger) {
        try {
            const triggers = JSON.parse(trigger.value);
            for (const eventName in triggers) {
                let detail = triggers[eventName];
                let target = document.body; // Default target

                if (typeof detail === 'object' && detail !== null && detail.target) {
                    const newTarget = htmx.find(detail.target);
                    if (newTarget) {
                        target = newTarget;
                    } else {
                        console.warn(`[server-commands] Trigger target "${detail.target}" not found.`);
                    }
                    delete detail.target; // Remove target from the detail payload
                }
                api.triggerEvent(target, eventName, detail);
            }
        } catch (e) {
            trigger.value.split(',').forEach(eventName => {
                api.triggerEvent(document.body, eventName.trim());
            });
        }
    }

    /**
     * Handles the location attribute, mimicking the HX-Location response header.
     * @param {string} redirectPath
     * A URL path or a JSON string with options for the htmx.ajax call.
     */
    function handleLocationAttribute(redirectPath) {
        let redirectSwapSpec = {};
        let path = redirectPath;

        // Check if the value is a JSON string to extract path and other options
        if (redirectPath.indexOf('{') === 0) {
            redirectSwapSpec = JSON.parse(redirectPath);
            path = redirectSwapSpec.path;
            delete redirectSwapSpec.path;
        }

        // 1. Save the current page to history before navigating away.
        saveCurrentPageToHistory();

        // 2. Make the AJAX request to fetch the new content.
        htmx.ajax('GET', path, api.mergeObjects({source: document.body}, redirectSwapSpec))
            .then(() => {
                // 3. After the content is loaded and swapped, push the new URL to the history.
                pushUrlIntoHistory(path);
            });
    }

    /**
     * This is a specialized version of the htmx swap function.
     *
     * WHY IT IS NECESSARY:
     * The standard `htmx.swap()` or `api.swap()` is a "fire-and-forget" function.
     * It performs the swap but returns `undefined`, so you cannot know when it
     * is finished.
     *
     * This extension needs to wait for the swap to complete before firing
     * `after-swap` triggers, and then wait for the settle phase to complete
     * before firing `after-settle` triggers.
     *
     * HOW IT'S DIFFERENT:
     * This function returns a Promise that resolves with another Promise.
     * 1. The outer promise resolves immediately after the DOM is changed.
     * `await`ing this promise pauses execution until the swap is done.
     * 2. The inner promise resolves after the settle delay is finished.
     * `await`ing this second promise pauses execution until settling is done.
     *
     * This allows the procedural script in `processHtmxTag` to correctly
     * time the execution of the different trigger types.
     */
    function swapAsync(target, content, swapSpec, swapOptions, settleInfo) {
        if (!swapOptions) {
            swapOptions = {}
        }
        return new Promise((resolveSwap, rejectSwap) => {
            let settleResolve = null, settleReject = null

            let doSwap = function() {
                swapOptions.beforeSwapCallback && swapOptions.beforeSwapCallback()
                target = resolveTarget(target)
                const rootNode = swapOptions.contextElement ? getRootNode(swapOptions.contextElement, false) : getDocument()
                const activeElt = document.activeElement
                let selectionInfo = {
                    elt: activeElt,
                    start: activeElt ? activeElt.selectionStart : null,
                    end: activeElt ? activeElt.selectionEnd : null
                }
                settleInfo = settleInfo || api.makeSettleInfo(target)

                if (swapSpec.swapStyle === 'textContent') {
                    target.textContent = content
                } else {
                    let fragment = makeFragment(content)
                    settleInfo.title = swapOptions.title || fragment.title
                    if (swapOptions.historyRequest) {
                        fragment = fragment.querySelector('[hx-history-elt],[data-hx-history-elt]') || fragment
                    }
                    if (swapOptions.selectOOB) {
                        const oobSelectValues = swapOptions.selectOOB.split(',')
                        for (let i = 0; i < oobSelectValues.length; i++) {
                            const oobSelectValue = oobSelectValues[i].split(':', 2)
                            let id = oobSelectValue[0].trim()
                            if (id.indexOf('#') === 0) id = id.substring(1)
                            const oobValue = oobSelectValue[1] || 'true'
                            const oobElement = fragment.querySelector('#' + id)
                            if (oobElement) api.oobSwap(oobValue, oobElement, settleInfo, rootNode)
                        }
                    }
                    findAndSwapOobElements(fragment, settleInfo, rootNode)
                    forEach(findAll(fragment, 'template'), function(template) {
                        if (template.content && findAndSwapOobElements(template.content, settleInfo, rootNode)) {
                            template.remove()
                        }
                    })
                    if (swapOptions.select) {
                        const newFragment = getDocument().createDocumentFragment()
                        forEach(fragment.querySelectorAll(swapOptions.select), function(node) {
                            newFragment.appendChild(node)
                        })
                        fragment = newFragment
                    }
                    handlePreservedElements(fragment)
                    swapWithStyle(swapSpec.swapStyle, swapOptions.contextElement, target, fragment, settleInfo)
                    restorePreservedElements()
                }

                if (selectionInfo.elt && !api.bodyContains(selectionInfo.elt) && getRawAttribute(selectionInfo.elt, 'id')) {
                    const newActiveElt = document.getElementById(getRawAttribute(selectionInfo.elt, 'id'))
                    const focusOptions = { preventScroll: swapSpec.focusScroll !== undefined ? !swapSpec.focusScroll : !htmx.config.defaultFocusScroll }
                    if (newActiveElt) {
                        if (selectionInfo.start && newActiveElt.setSelectionRange) {
                            try { newActiveElt.setSelectionRange(selectionInfo.start, selectionInfo.end) } catch (e) {}
                        }
                        newActiveElt.focus(focusOptions)
                    }
                }

                target.classList.remove(htmx.config.swappingClass)
                forEach(settleInfo.elts, function(elt) {
                    if (elt.classList) elt.classList.add(htmx.config.settlingClass)
                    api.triggerEvent(elt, 'htmx:afterSwap', swapOptions.eventInfo)
                })
                swapOptions.afterSwapCallback && swapOptions.afterSwapCallback()

                if (!swapSpec.ignoreTitle) handleTitle(settleInfo.title)

                const doSettle = function() {
                    forEach(settleInfo.tasks, function(task) { task.call() })
                    forEach(settleInfo.elts, function(elt) {
                        if (elt.classList) elt.classList.remove(htmx.config.settlingClass)
                        api.triggerEvent(elt, 'htmx:afterSettle', swapOptions.eventInfo)
                    })

                    if (swapOptions.anchor) {
                        const anchorTarget = asElement(resolveTarget('#' + swapOptions.anchor))
                        if (anchorTarget) anchorTarget.scrollIntoView({ block: 'start', behavior: 'auto' })
                    }

                    updateScrollState(settleInfo.elts, swapSpec)
                    swapOptions.afterSettleCallback && swapOptions.afterSettleCallback()
                    settleResolve && settleResolve()
                }

                let settleDelayPromise = Promise.resolve();
                if (swapSpec.settleDelay > 0) {
                    settleDelayPromise = new Promise(resolve => getWindow().setTimeout(() => { doSettle(); resolve(); }, swapSpec.settleDelay));
                } else {
                    doSettle()
                }
                resolveSwap(settleDelayPromise);
            }
            let shouldTransition = htmx.config.globalViewTransitions
            if (swapSpec.hasOwnProperty('transition')) {
                shouldTransition = swapSpec.transition
            }
            const elt = swapOptions.contextElement || getDocument()
            if (shouldTransition && api.triggerEvent(elt, 'htmx:beforeTransition', swapOptions.eventInfo) && typeof Promise !== 'undefined' && document.startViewTransition) {
                const settlePromise = new Promise(function(_resolve, _reject) {
                    settleResolve = _resolve
                    settleReject = _reject
                })
                const innerDoSwap = doSwap
                doSwap = function() {
                    document.startViewTransition(function() {
                        innerDoSwap()
                        return settlePromise
                    })
                }
            }

            try {
                if (swapSpec?.swapDelay && swapSpec.swapDelay > 0) {
                    getWindow().setTimeout(doSwap, swapSpec.swapDelay)
                } else {
                    doSwap()
                }
            } catch (e) {
                api.triggerErrorEvent(elt, 'htmx:swapError', swapOptions.eventInfo)
                settleReject && settleReject()
                rejectSwap(e)
            }
        });
    }


// ====================================================================
// BORROWED FROM HTMX INTERNAL API (and kept as close as possible)
// ====================================================================

    function parseInterval(str) {
        if (str == undefined) {
            return undefined
        }
        let interval = NaN
        if (str.slice(-2) == 'ms') {
            interval = parseFloat(str.slice(0, -2))
        } else if (str.slice(-1) == 's') {
            interval = parseFloat(str.slice(0, -1)) * 1000
        } else if (str.slice(-1) == 'm') {
            interval = parseFloat(str.slice(0, -1)) * 1000 * 60
        } else {
            interval = parseFloat(str)
        }
        return isNaN(interval) ? undefined : interval
    }

    function getDocument() {
        return document
    }

    function forEach(arr, func) {
        if (arr) {
            for (let i = 0; i < arr.length; i++) {
                func(arr[i])
            }
        }
    }

    function parseJSON(jString) {
        try {
            return JSON.parse(jString)
        } catch (error) {
            logError(error)
            return null
        }
    }

    function canAccessLocalStorage() {
        const test = 'htmx:sessionStorageTest'
        try {
            sessionStorage.setItem(test, test)
            sessionStorage.removeItem(test)
            return true
        } catch (e) {
            return false
        }
    }

    function normalizePath(path) {
        const url = new URL(path, 'http://x')
        if (url) {
            path = url.pathname + url.search
        }
        if (path != '/') {
            path = path.replace(/\/+$/, '')
        }
        return path
    }

    function isFunction(o) {
        return typeof o === 'function'
    }

    function asString(value) {
        return typeof value === 'string' ? value : null
    }

    var isReady = false
    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', function() {
            isReady = true
        })
    }
    function ready(fn) {
        if (isReady || (typeof document !== 'undefined' && document.readyState === 'complete')) {
            fn()
        } else {
            document.addEventListener('DOMContentLoaded', fn)
        }
    }

    function processEventArgs(arg1, arg2, arg3, arg4) {
        if (isFunction(arg2)) {
            return {
                target: getDocument().body,
                event: asString(arg1),
                listener: arg2,
                options: arg3
            }
        } else {
            return {
                target: resolveTarget(arg1),
                event: asString(arg2),
                listener: arg3,
                options: arg4
            }
        }
    }

    function removeEventListenerImpl(arg1, arg2, arg3) {
        ready(function() {
            const eventArgs = processEventArgs(arg1, arg2, arg3)
            eventArgs.target.removeEventListener(eventArgs.event, eventArgs.listener)
        })
        return isFunction(arg2) ? arg2 : arg3
    }

    function deInitOnHandlers(elt) {
        const internalData = api.getInternalData(elt)
        if (internalData.onHandlers) {
            for (let i = 0; i < internalData.onHandlers.length; i++) {
                const handlerInfo = internalData.onHandlers[i]
                removeEventListenerImpl(elt, handlerInfo.event, handlerInfo.listener)
            }
            delete internalData.onHandlers
        }
    }

    function logError(msg) {
        console.error(msg)
    }

// FIXED: Replaced with a mock to prevent crash, as we cannot access the private 'extensions' object from htmx core.
    function getExtensions(elt, extensionsToReturn, extensionsToIgnore) {
        // This is a mock implementation. It prevents a ReferenceError because this copied
        // function cannot access the private 'extensions' registry in the htmx core.
        // The consequence is that other extensions defining custom swap styles will not
        // be applied within a server-commands response. This is an acceptable limitation.
        return [];
    }

    function getHistoryElement() {
        const historyElt = getDocument().querySelector('[hx-history-elt],[data-hx-history-elt]')
        return historyElt || getDocument().body
    }

    function saveToHistoryCache(url, rootElt) {
        if (!canAccessLocalStorage()) {
            return
        }

        const innerHTML = cleanInnerHtmlForHistory(rootElt)
        const title = getDocument().title
        const scroll = window.scrollY

        if (htmx.config.historyCacheSize <= 0) {
            sessionStorage.removeItem('htmx-history-cache')
            return
        }

        url = normalizePath(url)

        const historyCache = parseJSON(sessionStorage.getItem('htmx-history-cache')) || []
        for (let i = 0; i < historyCache.length; i++) {
            if (historyCache[i].url === url) {
                historyCache.splice(i, 1)
                break
            }
        }

        const newHistoryItem = { url, content: innerHTML, title, scroll }

        api.triggerEvent(getDocument().body, 'htmx:historyItemCreated', { item: newHistoryItem, cache: historyCache })

        historyCache.push(newHistoryItem)
        while (historyCache.length > htmx.config.historyCacheSize) {
            historyCache.shift()
        }

        while (historyCache.length > 0) {
            try {
                sessionStorage.setItem('htmx-history-cache', JSON.stringify(historyCache))
                break
            } catch (e) {
                api.triggerErrorEvent(getDocument().body, 'htmx:historyCacheError', { cause: e, cache: historyCache })
                historyCache.shift()
            }
        }
    }

    function cleanInnerHtmlForHistory(elt) {
        const className = htmx.config.requestClass
        const clone = /** @type Element */ (elt.cloneNode(true))
        forEach(findAll(clone, '.' + className), function(child) {
            removeClassFromElement(child, className)
        })
        forEach(findAll(clone, '[data-disabled-by-htmx]'), function(child) {
            child.removeAttribute('disabled')
        })
        return clone.innerHTML
    }

    function saveCurrentPageToHistory() {
        const elt = getHistoryElement()
        let path = currentPathForHistory
        if (canAccessLocalStorage()) {
            path = sessionStorage.getItem('htmx-current-path-for-history')
        }
        path = path || location.pathname + location.search

        const disableHistoryCache = getDocument().querySelector('[hx-history="false" i],[data-hx-history="false" i]')
        if (!disableHistoryCache) {
            // FIXED: Use api.triggerEvent to call the original htmx function
            api.triggerEvent(getDocument().body, 'htmx:beforeHistorySave', { path, historyElt: elt })
            saveToHistoryCache(path, elt)
        }

        if (htmx.config.historyEnabled) history.replaceState({ htmx: true }, getDocument().title, location.href)
    }

    function pushUrlIntoHistory(path) {
        if (htmx.config.getCacheBusterParam) {
            path = path.replace(/org\.htmx\.cache-buster=[^&]*&?/, '')
            if (endsWith(path, '&') || endsWith(path, '?')) {
                path = path.slice(0, -1)
            }
        }
        if (htmx.config.historyEnabled) {
            history.pushState({ htmx: true }, '', path)
        }
        setCurrentPathForHistory(path)
    }

    function replaceUrlInHistory(path) {
        if (htmx.config.historyEnabled) history.replaceState({ htmx: true }, '', path)
        setCurrentPathForHistory(path)
    }

    let currentPathForHistory = (typeof location !== 'undefined') ? location.pathname + location.search : '';

    function setCurrentPathForHistory(path) {
        currentPathForHistory = path
        if (canAccessLocalStorage()) {
            sessionStorage.setItem('htmx-current-path-for-history', path)
        }
    }

    function getRawAttribute(elt, name) {
        return elt instanceof Element && elt.getAttribute(name)
    }

    function makeFragment(response) {
        const responseWithNoHead = response.replace(/<head(\s[^>]*)?>[\s\S]*?<\/head>/i, '')
        const startTag = getStartTag(responseWithNoHead)
        let fragment
        if (startTag === 'html') {
            fragment = new DocumentFragment()
            const doc = parseHTML(response)
            takeChildrenFor(fragment, doc.body)
            fragment.title = doc.title
        } else if (startTag === 'body') {
            fragment = new DocumentFragment()
            const doc = parseHTML(responseWithNoHead)
            takeChildrenFor(fragment, doc.body)
            fragment.title = doc.title
        } else {
            const doc = parseHTML('<body><template class="internal-htmx-wrapper">' + responseWithNoHead + '</template></body>')
            fragment = doc.querySelector('template').content
            fragment.title = doc.title
            var titleElement = fragment.querySelector('title')
            if (titleElement && titleElement.parentNode === fragment) {
                titleElement.remove()
                fragment.title = titleElement.innerText
            }
        }
        if (fragment) {
            if (htmx.config.allowScriptTags) {
                normalizeScriptTags(fragment)
            } else {
                fragment.querySelectorAll('script').forEach((script) => script.remove())
            }
        }
        return fragment
    }

    function getStartTag(str) {
        const tagMatcher = /<([a-z][^\/\0>\x20\t\r\n\f]*)/i
        const match = tagMatcher.exec(str)
        return match ? match[1].toLowerCase() : ''
    }

    function parseHTML(resp) {
        return new DOMParser().parseFromString(resp, 'text/html')
    }

    function takeChildrenFor(fragment, elt) {
        while (elt.childNodes.length > 0) {
            fragment.append(elt.childNodes[0])
        }
    }

    function normalizeScriptTags(fragment) {
        Array.from(fragment.querySelectorAll('script')).forEach((script) => {
            if (isJavaScriptScriptNode(script)) {
                const newScript = duplicateScript(script)
                const parent = script.parentNode
                try {
                    parent.insertBefore(newScript, script)
                } catch (e) {
                    logError(e)
                } finally {
                    script.remove()
                }
            }
        })
    }

    function duplicateScript(script) {
        const newScript = getDocument().createElement('script')
        forEach(script.attributes, function(attr) {
            newScript.setAttribute(attr.name, attr.value)
        })
        newScript.textContent = script.textContent
        newScript.async = false
        if (htmx.config.inlineScriptNonce) {
            newScript.nonce = htmx.config.inlineScriptNonce
        }
        return newScript
    }

    function isJavaScriptScriptNode(script) {
        return script.matches('script') && (script.type === 'text/javascript' || script.type === 'module' || script.type === '')
    }

    function updateScrollState(content, swapSpec) {
        const first = content[0]
        const last = content[content.length - 1]
        if (swapSpec.scroll) {
            var target = null
            if (swapSpec.scrollTarget) target = asElement(api.querySelectorExt(first, swapSpec.scrollTarget))
            if (swapSpec.scroll === 'top' && (first || target)) {
                target = target || first
                target.scrollTop = 0
            }
            if (swapSpec.scroll === 'bottom' && (last || target)) {
                target = target || last
                target.scrollTop = target.scrollHeight
            }
            if (typeof swapSpec.scroll === 'number') {
                getWindow().setTimeout(function() { window.scrollTo(0, swapSpec.scroll) }, 0)
            }
        }
        if (swapSpec.show) {
            var target = null
            if (swapSpec.showTarget) {
                let targetStr = swapSpec.showTarget
                if (swapSpec.showTarget === 'window') targetStr = 'body'
                target = asElement(api.querySelectorExt(first, targetStr))
            }
            if (swapSpec.show === 'top' && (first || target)) {
                target = target || first
                target.scrollIntoView({ block: 'start', behavior: htmx.config.scrollBehavior })
            }
            if (swapSpec.show === 'bottom' && (last || target)) {
                target = target || last
                target.scrollIntoView({ block: 'end', behavior: htmx.config.scrollBehavior })
            }
        }
    }

    function handleTitle(title) {
        if (title) {
            const titleElt = find('title')
            if (titleElt) {
                titleElt.textContent = title
            } else {
                window.document.title = title
            }
        }
    }

    function findAndSwapOobElements(fragment, settleInfo, rootNode) {
        var oobElts = findAll(fragment, '[hx-swap-oob], [data-hx-swap-oob]')
        forEach(oobElts, function(oobElement) {
            if (htmx.config.allowNestedOobSwaps || oobElement.parentElement === null) {
                const oobValue = api.getAttributeValue(oobElement, 'hx-swap-oob')
                if (oobValue != null) {
                    api.oobSwap(oobValue, oobElement, settleInfo, rootNode)
                }
            } else {
                oobElement.removeAttribute('hx-swap-oob')
                oobElement.removeAttribute('data-hx-swap-oob')
            }
        })
        return oobElts.length > 0
    }

    function restorePreservedElements() {
        const pantry = find('#--htmx-preserve-pantry--')
        if (pantry) {
            for (const preservedElt of [...pantry.children]) {
                const existingElement = find('#' + preservedElt.id)
                existingElement.parentNode.moveBefore(preservedElt, existingElement)
                existingElement.remove()
            }
            pantry.remove()
        }
    }

    function handlePreservedElements(fragment) {
        forEach(findAll(fragment, '[hx-preserve], [data-hx-preserve]'), function(preservedElt) {
            const id = api.getAttributeValue(preservedElt, 'id')
            const existingElement = getDocument().getElementById(id)
            if (existingElement != null) {
                if (preservedElt.moveBefore) {
                    let pantry = find('#--htmx-preserve-pantry--')
                    if (pantry == null) {
                        getDocument().body.insertAdjacentHTML('afterend', "<div id='--htmx-preserve-pantry--'></div>")
                        pantry = find('#--htmx-preserve-pantry--')
                    }
                    pantry.moveBefore(existingElement, null)
                } else {
                    preservedElt.parentNode.replaceChild(existingElement, preservedElt)
                }
            }
        })
    }

    function cloneAttributes(mergeTo, mergeFrom) {
        forEach(mergeTo.attributes, function(attr) {
            if (!mergeFrom.hasAttribute(attr.name)) {
                mergeTo.removeAttribute(attr.name)
            }
        })
        forEach(mergeFrom.attributes, function(attr) {
            mergeTo.setAttribute(attr.name, attr.value)
        })
    }

    function handleAttributes(parentNode, fragment, settleInfo) {
        forEach(fragment.querySelectorAll('[id]'), function(newNode) {
            const id = getRawAttribute(newNode, 'id')
            if (id && id.length > 0) {
                const normalizedId = id.replace("'", "\\'")
                const normalizedTag = newNode.tagName.replace(':', '\\:')
                const parentElt = asParentNode(parentNode)
                const oldNode = parentElt && parentElt.querySelector(normalizedTag + "[id='" + normalizedId + "']")
                if (oldNode && oldNode !== parentElt) {
                    const newAttributes = newNode.cloneNode()
                    cloneAttributes(newNode, oldNode)
                    settleInfo.tasks.push(function() {
                        cloneAttributes(newNode, newAttributes)
                    })
                }
            }
        })
    }

    function makeAjaxLoadTask(child) {
        return function() {
            removeClassFromElement(child, htmx.config.addedClass)
            processNode(asElement(child))
            processFocus(asParentNode(child))
            api.triggerEvent(child, 'htmx:load')
        }
    }

    function processFocus(child) {
        const autofocus = '[autofocus]'
        const autoFocusedElt = asHtmlElement(matches(child, autofocus) ? child : child.querySelector(autofocus))
        if (autoFocusedElt != null) {
            autoFocusedElt.focus()
        }
    }

    function insertNodesBefore(parentNode, insertBefore, fragment, settleInfo) {
        handleAttributes(parentNode, fragment, settleInfo)
        while (fragment.childNodes.length > 0) {
            const child = fragment.firstChild
            addClassToElement(asElement(child), htmx.config.addedClass)
            parentNode.insertBefore(child, insertBefore)
            if (child.nodeType !== Node.TEXT_NODE && child.nodeType !== Node.COMMENT_NODE) {
                settleInfo.tasks.push(makeAjaxLoadTask(child))
            }
        }
    }

    function cleanUpElement(element) {
        api.triggerEvent(element, 'htmx:beforeCleanupElement')
        deInitNode(element)
        forEach(element.children, function(child) { cleanUpElement(child) })
    }

    function swapOuterHTML(target, fragment, settleInfo) {
        if (target.tagName === 'BODY') {
            return swapInnerHTML(target, fragment, settleInfo)
        }
        let newElt
        const eltBeforeNewContent = target.previousSibling
        const parentNode = parentElt(target)
        if (!parentNode) {
            return
        }
        insertNodesBefore(parentNode, target, fragment, settleInfo)
        if (eltBeforeNewContent == null) {
            newElt = parentNode.firstChild
        } else {
            newElt = eltBeforeNewContent.nextSibling
        }
        settleInfo.elts = settleInfo.elts.filter(function(e) { return e !== target })
        while (newElt && newElt !== target) {
            if (newElt instanceof Element) {
                settleInfo.elts.push(newElt)
            }
            newElt = newElt.nextSibling
        }
        cleanUpElement(target)
        target.remove()
    }

    function swapAfterBegin(target, fragment, settleInfo) {
        return insertNodesBefore(target, target.firstChild, fragment, settleInfo)
    }

    function swapBeforeBegin(target, fragment, settleInfo) {
        return insertNodesBefore(parentElt(target), target, fragment, settleInfo)
    }

    function swapBeforeEnd(target, fragment, settleInfo) {
        return insertNodesBefore(target, null, fragment, settleInfo)
    }

    function swapAfterEnd(target, fragment, settleInfo) {
        return insertNodesBefore(parentElt(target), target.nextSibling, fragment, settleInfo)
    }

    function swapDelete(target) {
        cleanUpElement(target)
        const parent = parentElt(target)
        if (parent) {
            return parent.removeChild(target)
        }
    }

    function swapInnerHTML(target, fragment, settleInfo) {
        const firstChild = target.firstChild
        insertNodesBefore(target, firstChild, fragment, settleInfo)
        if (firstChild) {
            while (firstChild.nextSibling) {
                cleanUpElement(firstChild.nextSibling)
                target.removeChild(firstChild.nextSibling)
            }
            cleanUpElement(firstChild)
            target.removeChild(firstChild)
        }
        // Note: Unlike HTMX core which may rely on different settling behavior,
        // ensure target is included for settling class application in innerHTML swaps
        if (settleInfo.elts.indexOf(target) === -1) {
            settleInfo.elts.push(target)
        }
    }

    function swapWithStyle(swapStyle, elt, target, fragment, settleInfo) {
        switch (swapStyle) {
            case 'none': return
            case 'outerHTML': swapOuterHTML(target, fragment, settleInfo); return
            case 'afterbegin': swapAfterBegin(target, fragment, settleInfo); return
            case 'beforebegin': swapBeforeBegin(target, fragment, settleInfo); return
            case 'beforeend': swapBeforeEnd(target, fragment, settleInfo); return
            case 'afterend': swapAfterEnd(target, fragment, settleInfo); return
            case 'delete': swapDelete(target); return
            default:
                var extensions = getExtensions(elt)
                for (let i = 0; i < extensions.length; i++) {
                    const ext = extensions[i]
                    try {
                        const newElements = ext.handleSwap(swapStyle, target, fragment, settleInfo)
                        if (newElements) {
                            if (Array.isArray(newElements)) {
                                for (let j = 0; j < newElements.length; j++) {
                                    const child = newElements[j]
                                    if (child.nodeType !== Node.TEXT_NODE && child.nodeType !== Node.COMMENT_NODE) {
                                        settleInfo.tasks.push(makeAjaxLoadTask(child))
                                    }
                                }
                            }
                            return
                        }
                    } catch (e) {
                        logError(e)
                    }
                }
                if (swapStyle === 'innerHTML') {
                    swapInnerHTML(target, fragment, settleInfo)
                } else {
                    swapWithStyle(htmx.config.defaultSwapStyle, elt, target, fragment, settleInfo)
                }
        }
    }

    function isInlineSwap(swapStyle, target) {
        const extensions = getExtensions(target)
        for (let i = 0; i < extensions.length; i++) {
            const extension = extensions[i]
            try {
                if (extension.isInlineSwap(swapStyle)) return true
            } catch (e) {
                logError(e)
            }
        }
        return swapStyle === 'outerHTML'
    }

    function findAll(eltOrSelector, selector) {
        if (typeof eltOrSelector !== 'string') {
            return eltOrSelector.querySelectorAll(selector)
        } else {
            return findAll(getDocument(), eltOrSelector)
        }
    }

    function removeClassFromElement(node, clazz, delay) {
        let elt = asElement(resolveTarget(node))
        if (!elt) return
        if (delay) {
            getWindow().setTimeout(function() {
                removeClassFromElement(elt, clazz)
                elt = null
            }, delay)
        } else {
            if (elt.classList) {
                elt.classList.remove(clazz)
                if (elt.classList.length === 0) {
                    elt.removeAttribute('class')
                }
            }
        }
    }

    function addClassToElement(elt, clazz, delay) {
        elt = asElement(resolveTarget(elt))
        if (!elt) return
        if (delay) {
            getWindow().setTimeout(function() {
                addClassToElement(elt, clazz)
                elt = null
            }, delay)
        } else {
            elt.classList && elt.classList.add(clazz)
        }
    }

// The processNode function and its dependencies are kept local as they are not on the internalAPI
// and are required by the swap logic.
    function processNode(elt) {
        elt = resolveTarget(elt)
        if (eltIsDisabled(elt)) {
            cleanUpElement(elt)
            return
        }
        const elementsToInit = []
        if (maybeDeInitAndHash(elt)) elementsToInit.push(elt)
        forEach(findElementsToProcess(elt), function(child) {
            if (eltIsDisabled(child)) {
                cleanUpElement(child)
                return
            }
            if (maybeDeInitAndHash(child)) elementsToInit.push(child)
        })
        forEach(findHxOnWildcardElements(elt), processHxOnWildcard)
        forEach(elementsToInit, initNode)
    }

    function deInitNode(element) {
        const internalData = api.getInternalData(element)
        if (internalData.timeout) clearTimeout(internalData.timeout)
        if (internalData.listenerInfos) {
            forEach(internalData.listenerInfos, function(info) {
                if (info.on) removeEventListenerImpl(info.on, info.trigger, info.listener)
            })
        }
        deInitOnHandlers(element)
        forEach(Object.keys(internalData), function(key) { if (key !== 'firstInitCompleted') delete internalData[key] })
    }

    function closest(elt, selector) {
        elt = asElement(resolveTarget(elt))
        if (elt) {
            return elt.closest(selector)
        }
        return null
    }

    function eltIsDisabled(elt) {
        return closest(elt, htmx.config.disableSelector)
    }

    function maybeDeInitAndHash(elt) {
        if (!(elt instanceof Element)) return false
        const nodeData = api.getInternalData(elt)
        const hash = attributeHash(elt)
        if (nodeData.initHash !== hash) {
            deInitNode(elt)
            nodeData.initHash = hash
            return true
        }
        return false
    }

    function stringHash(string, hash) {
        let char = 0
        while (char < string.length) {
            hash = (hash << 5) - hash + string.charCodeAt(char++) | 0
        }
        return hash
    }

    function attributeHash(elt) {
        let hash = 0
        for (let i = 0; i < elt.attributes.length; i++) {
            const attribute = elt.attributes[i]
            if (attribute.value) {
                hash = stringHash(attribute.name, hash)
                hash = stringHash(attribute.value, hash)
            }
        }
        return hash
    }

    const VERBS = ['get', 'post', 'put', 'delete', 'patch']
    const VERB_SELECTOR = VERBS.map(function(verb) { return '[hx-' + verb + '], [data-hx-' + verb + ']' }).join(', ')

    function findElementsToProcess(elt) {
        if (elt.querySelectorAll) {
            const boostedSelector = ', [hx-boost] a, [data-hx-boost] a, a[hx-boost], a[data-hx-boost]'
            return elt.querySelectorAll(VERB_SELECTOR + boostedSelector + ", form, [type='submit'], [hx-ext], [data-hx-ext], [hx-trigger], [data-hx-trigger]")
        } else {
            return []
        }
    }

    const HX_ON_QUERY = new XPathEvaluator().createExpression('.//*[@*[ starts-with(name(), "hx-on:") or starts-with(name(), "data-hx-on:") or starts-with(name(), "hx-on-") or starts-with(name(), "data-hx-on-") ]]')

    function findHxOnWildcardElements(elt) {
        const elements = []
        if (elt instanceof DocumentFragment) {
            for (const child of elt.childNodes) processHXOnRoot(child, elements)
        } else {
            processHXOnRoot(elt, elements)
        }
        return elements
    }

    function processHXOnRoot(elt, elements) {
        if (shouldProcessHxOn(elt)) elements.push(asElement(elt))
        const iter = HX_ON_QUERY.evaluate(elt)
        let node = null
        while (node = iter.iterateNext()) elements.push(asElement(node))
    }

    function startsWith(str, prefix) {
        return str.substring(0, prefix.length) === prefix
    }

    function shouldProcessHxOn(node) {
        const elt = asElement(node)
        if (!elt) return false
        const attributes = elt.attributes
        for (let j = 0; j < attributes.length; j++) {
            const attrName = attributes[j].name
            if (startsWith(attrName, 'hx-on:') || startsWith(attrName, 'data-hx-on:') || startsWith(attrName, 'hx-on-') || startsWith(attrName, 'data-hx-on-')) {
                return true
            }
        }
        return false
    }

    function processHxOnWildcard(elt) {
        deInitOnHandlers(elt)
        for (let i = 0; i < elt.attributes.length; i++) {
            const name = elt.attributes[i].name
            const value = elt.attributes[i].value
            if (startsWith(name, 'hx-on') || startsWith(name, 'data-hx-on')) {
                const afterOnPosition = name.indexOf('-on') + 3
                const nextChar = name.slice(afterOnPosition, afterOnPosition + 1)
                if (nextChar === '-' || nextChar === ':') {
                    let eventName = name.slice(afterOnPosition + 1)
                    if (startsWith(eventName, ':')) eventName = 'htmx' + eventName
                    else if (startsWith(eventName, '-')) eventName = 'htmx:' + eventName.slice(1)
                    else if (startsWith(eventName, 'htmx-')) eventName = 'htmx:' + eventName.slice(5)
                    addHxOnEventHandler(elt, eventName, value)
                }
            }
        }
    }

    function maybeEval(elt, toEval, defaultVal) {
        if (htmx.config.allowEval) {
            return toEval()
        } else {
            api.triggerErrorEvent(elt, 'htmx:evalDisallowedError')
            return defaultVal
        }
    }

    function addHxOnEventHandler(elt, eventName, code) {
        const nodeData = api.getInternalData(elt)
        if (!Array.isArray(nodeData.onHandlers)) nodeData.onHandlers = []
        let func
        const listener = function(e) {
            maybeEval(elt, function() {
                if (eltIsDisabled(elt)) return
                if (!func) func = new Function('event', code)
                func.call(elt, e)
            })
        }
        elt.addEventListener(eventName, listener)
        nodeData.onHandlers.push({ event: eventName, listener })
    }

    function initNode(elt) {
        api.triggerEvent(elt, 'htmx:beforeProcessNode')
        const nodeData = api.getInternalData(elt)
        const triggerSpecs = api.getTriggerSpecs(elt)
        const hasExplicitHttpAction = processVerbs(elt, nodeData, triggerSpecs)
        if (!hasExplicitHttpAction) {
            if (api.getClosestAttributeValue(elt, 'hx-boost') === 'true') {
                boostElement(elt, nodeData, triggerSpecs)
            } else if (api.hasAttribute(elt, 'hx-trigger')) {
                triggerSpecs.forEach(function(triggerSpec) {
                    addTriggerHandler(elt, triggerSpec, nodeData, function() {})
                })
            }
        }
        if (elt.tagName === 'FORM' || (getRawAttribute(elt, 'type') === 'submit' && api.hasAttribute(elt, 'form'))) {
            initButtonTracking(elt)
        }
        nodeData.firstInitCompleted = true
        api.triggerEvent(elt, 'htmx:afterProcessNode')
    }

    function asElement(elt) {
        return elt instanceof Element ? elt : null
    }

    function parentElt(elt) {
        const parent = elt.parentElement
        if (!parent && elt.parentNode instanceof ShadowRoot) return elt.parentNode
        return parent
    }

    function resolveTarget(eltOrSelector, context) {
        if (typeof eltOrSelector === 'string') {
            return find(asParentNode(context) || document, eltOrSelector)
        } else {
            return eltOrSelector
        }
    }

    function find(eltOrSelector, selector) {
        if (typeof eltOrSelector !== 'string') {
            return eltOrSelector.querySelector(selector)
        } else {
            return find(getDocument(), eltOrSelector)
        }
    }

    function asParentNode(elt) {
        return elt instanceof Element || elt instanceof Document || elt instanceof DocumentFragment ? elt : null
    }

    function asHtmlElement(elt) {
        return elt instanceof HTMLElement ? elt : null
    }

    function toArray(arr) {
        const returnArr = []
        if (arr) {
            for (let i = 0; i < arr.length; i++) {
                returnArr.push(arr[i])
            }
        }
        return returnArr
    }

    function matches(elt, selector) {
        return elt instanceof Element && elt.matches(selector)
    }

    function getWindow() {
        return window
    }

    function getRootNode(elt, global) {
        return elt.getRootNode ? elt.getRootNode({ composed: global }) : getDocument()
    }

    function endsWith(str, suffix) {
        return str.substring(str.length - suffix.length) === suffix
    }

    function processVerbs(elt, nodeData, triggerSpecs) {
        let explicitAction = false
        forEach(VERBS, function(verb) {
            if (api.hasAttribute(elt, 'hx-' + verb)) {
                const path = api.getAttributeValue(elt, 'hx-' + verb)
                explicitAction = true
                nodeData.path = path
                nodeData.verb = verb
                triggerSpecs.forEach(function(triggerSpec) {
                    api.addTriggerHandler(elt, triggerSpec, nodeData, function(node, evt) {
                        const elt = asElement(node)
                        if (eltIsDisabled(elt)) {
                            cleanUpElement(elt)
                            return
                        }
                        api.ajax(verb, path, elt, evt)
                    })
                })
            }
        })
        return explicitAction
    }

    function boostElement(elt, nodeData, triggerSpecs) {
        if ((elt instanceof HTMLAnchorElement && isLocalLink(elt) && (elt.target === '' || elt.target === '_self')) || (elt.tagName === 'FORM' && String(getRawAttribute(elt, 'method')).toLowerCase() !== 'dialog')) {
            nodeData.boosted = true
            let verb, path
            if (elt.tagName === 'A') {
                verb = (/** @type HttpVerb */('get'))
                path = getRawAttribute(elt, 'href')
            } else {
                const rawAttribute = getRawAttribute(elt, 'method')
                verb = (/** @type HttpVerb */(rawAttribute ? rawAttribute.toLowerCase() : 'get'))
                path = getRawAttribute(elt, 'action')
                if (path == null || path === '') {
                    // if there is no action attribute on the form set path to current href before the
                    // following logic to properly clear parameters on a GET (not on a POST!)
                    path = location.href
                }
                if (verb === 'get' && path.includes('?')) {
                    path = path.replace(/\?[^#]+/, '')
                }
            }
            triggerSpecs.forEach(function(triggerSpec) {
                api.addEventListener(elt, function(node, evt) {
                    const elt = asElement(node)
                    if (eltIsDisabled(elt)) {
                        cleanUpElement(elt)
                        return
                    }
                    api.ajax(verb, path, elt, evt)
                }, nodeData, triggerSpec, true)
            })
        }
    }

    function isLocalLink(elt) {
        return location.hostname === elt.hostname &&
            getRawAttribute(elt, 'href') &&
            getRawAttribute(elt, 'href').indexOf('#') !== 0
    }
})();