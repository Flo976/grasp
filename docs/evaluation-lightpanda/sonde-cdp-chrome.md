# chrome — Chrome/150.0.7871.114 (ws://127.0.0.1:45493/devtools/browser/c0841989-5332-46d1-8278-019d20359994)

| Méthode | OK | ms | Réponse |
|---|---|---|---|
| Browser.getVersion | oui | 4 | {"protocolVersion":"1.3","product":"Chrome/150.0.7871.114","revision":"@f405107495a07cb1bfcf687d4af8d91117098db6","userAgent":"Mozilla/5.0 (X11; Linux x86_64… |
| Target.getTargets | oui | 1 | {"targetInfos":[{"targetId":"8504C38B15889BB5CA79F05BE2CDFB5C","type":"service_worker","title":"Service Worker chrome-extension://fignfifoniblkonapihmkfakmlg… |
| Target.createTarget | oui | 14 | {"targetId":"2ABC2495CF6AC8CCE4EB55C6800F5DCC"} |
| Target.attachToTarget | oui | 3 | {"sessionId":"37DC639091440E6483D56D9374A8DDC2"} |
| Target.getTargetInfo | oui | 3 | {"targetInfo":{"targetId":"2ABC2495CF6AC8CCE4EB55C6800F5DCC","type":"page","title":"about:blank","url":"about:blank","attached":true,"canAccessOpener":false,… |
| Page.enable | oui | 2 | {} |
| DOM.enable | oui | 3 | {} |
| Accessibility.enable | oui | 1 | {} |
| Runtime.enable | oui | 3 | {} |
| Log.enable | oui | 1 | {} |
| Network.enable | oui | 2 | {} |
| Fetch.enable | oui | 1 | {} |
| Target.setAutoAttach (session) | oui | 1 | {} |
| Page.getFrameTree | oui | 2 | {"frameTree":{"frame":{"id":"2ABC2495CF6AC8CCE4EB55C6800F5DCC","loaderId":"BEF7BF2E7BDA0E9F227C79645497C437","url":"about:blank","domainAndRegistry":"","secu… |
| Browser.setDownloadBehavior | oui | 0 | {} |
| Page.setDownloadBehavior | oui | 0 | {} |
| Target.setAutoAttach (navigateur) | oui | 1 | {} |
| Fetch.continueRequest | oui | 0 | {} |
| Page.navigate | oui | 30 | {"frameId":"2ABC2495CF6AC8CCE4EB55C6800F5DCC","loaderId":"8DF9A9A4D1A5C7DD5F1597F74136C460","isDownload":false} |
| Page.loadEventFired (événement) | oui | 0 | reçu |
| Fetch.requestPaused (événement) | oui | 0 | 1 reçu(s) |
| Fetch.enable (motifs vides, pour la suite) | oui | 17 | {} |
| Page.getNavigationHistory | oui | 2 | {"currentIndex":1,"entries":[{"id":7,"url":"about:blank","userTypedURL":"about:blank","title":"","transitionType":"auto_toplevel"},{"id":10,"url":"http://127… |
| Page.getLayoutMetrics | oui | 3 | {"layoutViewport":{"pageX":0,"pageY":0,"clientWidth":780,"clientHeight":493},"visualViewport":{"offsetX":0,"offsetY":0,"pageX":0,"pageY":0,"clientWidth":780,… |
| Runtime.evaluate | oui | 2 | {"result":{"type":"string","value":"Inscription\|false\|Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/… |
| Page.createIsolatedWorld | oui | 3 | {"executionContextId":3} |
| Runtime.evaluate (monde isolé) | oui | 0 | {"result":{"type":"number","value":2,"description":"2"}} |
| Accessibility.getFullAXTree | oui | 3 | {"nodes":[{"nodeId":"26","ignored":false,"role":{"type":"internalRole","value":"RootWebArea"},"chromeRole":{"type":"internalRole","value":144},"name":{"type"… |
|   ↳ getFullAXTree : nœuds | oui | 0 | 58 nœuds ; rôles : RootWebArea,none,banner,main,navigation,heading,form,paragraph,button,link,StaticText,generic,InlineTextBox,LabelText,textbox,combobox,checkbox,MenuListPopup,option |
| Accessibility.queryAXTree | oui | 15 | {"nodes":[{"nodeId":"66","ignored":false,"role":{"type":"role","value":"button"},"chromeRole":{"type":"internalRole","value":9},"name":{"type":"computedStrin… |
| DOM.getDocument | oui | 1 | {"root":{"nodeId":1,"backendNodeId":26,"nodeType":9,"nodeName":"#document","localName":"","nodeValue":"","childNodeCount":2,"children":[{"nodeId":2,"parentId… |
| DOM.querySelectorAll | oui | 1 | {"nodeIds":[22]} |
| DOM.describeNode | oui | 0 | {"node":{"nodeId":22,"backendNodeId":21,"nodeType":1,"nodeName":"INPUT","localName":"input","nodeValue":"","childNodeCount":0,"attributes":["id","nom","name"… |
| DOM.describeNode (backendNodeId) | oui | 0 | {"node":{"nodeId":22,"backendNodeId":21,"nodeType":1,"nodeName":"INPUT","localName":"input","nodeValue":"","childNodeCount":0,"attributes":["id","nom","name"… |
| DOM.resolveNode | oui | 1 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","description":"input#nom","objectId":"858790368108284501.2.1"}} |
| Runtime.callFunctionOn | oui | 1 | {"result":{"type":"string","value":"INPUT#nom"}} |
| DOM.resolveNode (monde isolé) | oui | 1 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","description":"input#nom","objectId":"858790368108284501.3.1"}} |
| Runtime.callFunctionOn (getBoundingClientRect) | oui | 1 | {"result":{"type":"number","value":185,"description":"185"}} |
| Runtime.getProperties | oui | 1 | {"result":[],"internalProperties":[{"name":"[[Prototype]]","value":{"type":"object","className":"HTMLInputElement","description":"HTMLInputElement","objectId… |
| DOM.scrollIntoViewIfNeeded | oui | 0 | {} |
| DOM.getContentQuads | oui | 0 | {"quads":[[44,105.875,229,105.875,229,126.875,44,126.875]]} |
| DOM.focus | oui | 2 | {} |
| Input.insertText | oui | 2 | {} |
| Input.dispatchKeyEvent | oui | 6 | {} |
| Input.dispatchKeyEvent (keyUp) | oui | 1 | {} |
| Runtime.evaluate (valeur saisie) | oui | 1 | {"result":{"type":"string","value":"Adab"}} |
|   ↳ saisie effective | oui | 0 | "Adab" |
| Runtime.evaluate (boîte #cgu) | oui | 1 | {"result":{"type":"string","value":"{\"x\":12,\"y\":190.875,\"width\":13,\"height\":13,\"top\":190.875,\"right\":25,\"bottom\":203.875,\"left\":12}"}} |
| Input.dispatchMouseEvent (mouseMoved) | oui | 14 | {} |
| Input.dispatchMouseEvent (mousePressed) | oui | 1 | {} |
| Input.dispatchMouseEvent (mouseReleased) | oui | 0 | {} |
| Runtime.evaluate (case cochée ?) | oui | 0 | {"result":{"type":"boolean","value":true}} |
|   ↳ clic souris effectif (case cochée) | oui | 0 | true à (19,197) |
| Runtime.releaseObject | oui | 0 | {} |
| Runtime.releaseObjectGroup | oui | 0 | {} |
| Emulation.setFocusEmulationEnabled | oui | 1 | {} |
| Emulation.setDeviceMetricsOverride | oui | 1 | {} |
| Emulation.clearDeviceMetricsOverride | oui | 0 | {} |
| Network.getCookies | oui | 0 | {"cookies":[]} |
| Page.captureScreenshot | oui | 37 | {"data":"iVBORw0KGgoAAAANSUhEUgAAAwwAAAHtCAIAAAA7mm4iAAAQAElEQVR4nOzdD8wc9Z3n+XqMmacYkulCe8NTSIldvgRcOo1xjQROZcYOFYGHTkyODuE2RTKIZhhdGub20mFOcnu0ujR7q6Os24OO… |
|   ↳ capture PNG | oui | 0 | 14 Ko |
| Page.printToPDF | oui | 20 | {"data":"JVBERi0xLjQKJdPr6eEKMSAwIG9iago8PC9UaXRsZSAoSW5zY3JpcHRpb24pCi9DcmVhdG9yIChNb3ppbGxhLzUuMCBcKFgxMTsgTGludXggeDg2XzY0XCkgQXBwbGVXZWJLaXQvNTM3LjM2IFwo… |
|   ↳ PDF | oui | 0 | 29 Ko |
| Page.bringToFront | oui | 0 | {} |
| Page.javascriptDialogOpening (événement) | oui | 0 | reçu |
| Page.handleJavaScriptDialog | oui | 5 | {} |
| Runtime.runIfWaitingForDebugger | oui | 1 | {} |
| Runtime.evaluate (console/exception/fetch) | oui | 2 | {"result":{"type":"number","value":1,"description":"1"}} |
| Target.detachFromTarget | oui | 1 | {} |
| Target.closeTarget | oui | 0 | {"success":true} |

| Événement | Reçus |
|---|---|
| Page.frameNavigated | 1 |
| Page.frameStartedLoading | 1 |
| Page.frameStoppedLoading | 1 |
| Page.frameRequestedNavigation | 0 |
| Page.navigatedWithinDocument | 0 |
| Page.frameDetached | 0 |
| Page.loadEventFired | 1 |
| Runtime.executionContextCreated | 3 |
| Runtime.executionContextDestroyed | 0 |
| Runtime.executionContextsCleared | 2 |
| Runtime.consoleAPICalled | 2 |
| Runtime.exceptionThrown | 1 |
| Log.entryAdded | 1 |
| Network.requestWillBeSent | 3 |
| Network.responseReceived | 3 |
| Network.loadingFinished | 3 |
| Network.loadingFailed | 0 |
| Target.attachedToTarget | 5 |
| Target.detachedFromTarget | 2 |
| Fetch.requestPaused | 1 |
| Page.javascriptDialogOpening | 1 |

Autres événements : Page.frameStartedNavigating, Inspector.workerScriptLoaded, Network.requestWillBeSentExtraInfo, Network.responseReceivedExtraInfo, Network.policyUpdated, DOM.documentUpdated, Network.dataReceived, Page.domContentEventFired, Accessibility.loadComplete, DOM.childNodeInserted, DOM.characterDataModified, Page.frameResized, DOM.scrollableFlagUpdated, Page.javascriptDialogClosed, Accessibility.nodesUpdated, Inspector.detached
