# obscura — Chrome/145.0.0.0 (ws://127.0.0.1:9444/devtools/browser)

| Méthode | OK | ms | Réponse |
|---|---|---|---|
| Browser.getVersion | oui | 1 | {"protocolVersion":"1.3","product":"Chrome/145.0.0.0","revision":"@0000000000000000000000000000000000000000","userAgent":"Mozilla/5.0 (X11; Linux x86_64) App… |
| Target.getTargets | oui | 1 | {"targetInfos":[]} |
| Target.createTarget | oui | 1 | {"targetId":"page-1"} |
| Target.attachToTarget | oui | 0 | {"sessionId":"page-1-session-1"} |
| Target.getTargetInfo | oui | 0 | {"targetInfo":{"targetId":"page-1","type":"page","title":"","url":"about:blank","attached":true,"canAccessOpener":false,"browserContextId":"default"}} |
| Page.enable | oui | 1 | {} |
| DOM.enable | oui | 0 | {} |
| Accessibility.enable | oui | 0 | {} |
| Runtime.enable | oui | 0 | {} |
| Log.enable | oui | 0 | {} |
| Network.enable | oui | 0 | {} |
| Fetch.enable | oui | 4 | {} |
| Target.setAutoAttach (session) | oui | 0 | {} |
| Page.getFrameTree | oui | 0 | {"frameTree":{"frame":{"id":"page-1","loaderId":"loader-blank-page-1","url":"about:blank","domainAndRegistry":"","securityOrigin":"null","mimeType":"text/htm… |
| Browser.setDownloadBehavior | oui | 0 | {} |
| Page.setDownloadBehavior | oui | 0 | {} |
| Target.setAutoAttach (navigateur) | oui | 0 | {} |
| Fetch.continueRequest | oui | 0 | {} |
| Page.navigate | oui | 6 | {"frameId":"page-1","loaderId":"page-1.1"} |
| Page.loadEventFired (événement) | oui | 0 | reçu |
| Fetch.requestPaused (événement) | oui | 0 | 1 reçu(s) |
| Fetch.enable (motifs vides, pour la suite) | oui | 1 | {} |
| Page.getNavigationHistory | oui | 0 | {"currentIndex":1,"entries":[{"id":0,"url":"about:blank","userTypedURL":"about:blank","title":"","transitionType":"typed"},{"id":1,"url":"http://127.0.0.1:45… |
| Page.getLayoutMetrics | oui | 1 | {"layoutViewport":{"pageX":0,"pageY":0,"clientWidth":1280,"clientHeight":720},"visualViewport":{"offsetX":0,"offsetY":0,"pageX":0,"pageY":0,"clientWidth":128… |
| Runtime.evaluate | oui | 0 | {"result":{"type":"string","description":"Inscription\|false\|Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0… |
| Page.createIsolatedWorld | oui | 0 | {"executionContextId":4} |
| Runtime.evaluate (monde isolé) | oui | 0 | {"result":{"type":"number","description":"2.0","value":2}} |
| Accessibility.getFullAXTree | oui | 1 | {"nodes":[{"backendDOMNodeId":0,"role":{"type":"role","value":"RootWebArea"},"nodeId":"1","ignored":false,"childIds":["2"]},{"backendDOMNodeId":2,"role":{"ty… |
|   ↳ getFullAXTree : nœuds | oui | 0 | 60 nœuds ; rôles : RootWebArea,generic,StaticText,banner,navigation,link,main,heading,form,LabelText,textbox,combobox,checkbox,button |
| Accessibility.queryAXTree | oui | 0 | {} |
| DOM.getDocument | oui | 1 | {"root":{"nodeId":0,"backendNodeId":0,"childNodeCount":2,"nodeType":9,"nodeName":"#document","localName":"","nodeValue":"","documentURL":"","baseURL":"","xml… |
| DOM.querySelectorAll | oui | 0 | {"nodeIds":[29]} |
| DOM.describeNode | oui | 0 | {"node":{"nodeId":29,"backendNodeId":29,"childNodeCount":0,"nodeType":1,"nodeName":"INPUT","localName":"input","nodeValue":"","attributes":["id","nom","name"… |
| DOM.describeNode (backendNodeId) | oui | 0 | {"node":{"nodeId":29,"backendNodeId":29,"childNodeCount":0,"nodeType":1,"nodeName":"INPUT","localName":"input","nodeValue":"","attributes":["id","nom","name"… |
| DOM.resolveNode | oui | 0 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","description":"input","objectId":"{\"injectedScriptId\":1,\"id\":4129}"}} |
| Runtime.callFunctionOn | oui | 1 | {"result":{"type":"string","description":"INPUT#nom","value":"INPUT#nom"}} |
| DOM.resolveNode (monde isolé) | oui | 0 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","description":"input","objectId":"{\"injectedScriptId\":1,\"id\":4131}"}} |
| Runtime.callFunctionOn (getBoundingClientRect) | oui | 1 | {"result":{"type":"number","description":"177.0","value":177}} |
| Runtime.getProperties | oui | 0 | {"result":[{"name":"_nid","value":{"type":"number","value":29},"configurable":true,"enumerable":true,"writable":true,"isOwn":true},{"name":"_tagName","value"… |
| DOM.scrollIntoViewIfNeeded | oui | 1 | {} |
| DOM.getContentQuads | oui | 0 | {"quads":[[46,105,223,105,223,126,46,126]]} |
| DOM.focus | oui | 0 | {} |
| Input.insertText | oui | 1 | {} |
| Input.dispatchKeyEvent | oui | 1 | {} |
| Input.dispatchKeyEvent (keyUp) | oui | 0 | {} |
| Runtime.evaluate (valeur saisie) | oui | 0 | {"result":{"type":"string","description":"Adab","value":"Adab"}} |
|   ↳ saisie effective | oui | 0 | "Adab" |
| Runtime.evaluate (boîte #cgu) | oui | 0 | {"result":{"type":"string","description":"{\"x\":12,\"y\":190,\"width\":13,\"height\":13,\"top\":190,\"right\":25,\"bottom\":203,\"left\":12}","value":"{\"x\… |
| Input.dispatchMouseEvent (mouseMoved) | oui | 1 | {} |
| Input.dispatchMouseEvent (mousePressed) | oui | 1 | {} |
| Input.dispatchMouseEvent (mouseReleased) | oui | 1 | {} |
| Runtime.evaluate (case cochée ?) | oui | 0 | {"result":{"type":"boolean","description":"true","value":true}} |
|   ↳ clic souris effectif (case cochée) | oui | 0 | true à (19,197) |
| Runtime.releaseObject | oui | 0 | {} |
| Runtime.releaseObjectGroup | oui | 0 | {} |
| Emulation.setFocusEmulationEnabled | oui | 0 | {} |
| Emulation.setDeviceMetricsOverride | oui | 0 | {} |
| Emulation.clearDeviceMetricsOverride | oui | 0 | {} |
| Network.getCookies | oui | 0 | {"cookies":[]} |
| Page.captureScreenshot | oui | 24 | {"data":"iVBORw0KGgoAAAANSUhEUgAABQAAAALQCAYAAADPfd1WAABLDUlEQVR4nO3dd5RV1f3w4e8I0puAWFA0gYgK9kbsRvPG3ntviSjYYtfYohKxJJqoEUuwGxONvRtEjS2xYEF/NuxiRUBFpb7u7ZrJ… |
|   ↳ capture PNG | oui | 0 | 19 Ko |
| Page.printToPDF | oui | 40 | {"obscuraPrintMode":"print-media-raster","obscuraPrintBackground":false,"obscuraRequestedPrintBackground":false,"obscuraTaggedPDF":false,"obscuraRequestedTag… |
|   ↳ PDF | oui | 0 | 41 Ko |
| Page.bringToFront | NON | 1 | Page.bringToFront: Unknown Page method: bringToFront |
| Page.javascriptDialogOpening (événement) | NON | 0 | non reçu en 4 s |
| Runtime.runIfWaitingForDebugger | oui | 0 | {} |
| Runtime.evaluate (console/exception/fetch) | oui | 1 | {"result":{"type":"number","description":"1.0","value":1}} |
| Target.getTargets (2e connexion) | oui | 0 | [] |
| 2e connexion | NON | 0 | Target.attachToTarget: Target not found |
| Target.createTarget (2e onglet) | oui | 1 | {"targetId":"page-2"} |
| Target.closeTarget (2e onglet) | oui | 0 | {"success":true} |
| Fetch.disable (pour la suite) | oui | 0 | {} |
| Page.navigate (/pw-editeur) | oui | 5 | {"frameId":"page-1","loaderId":"loader-92aa8652-298d-46cf-8510-fc1a9c528110"} |
| DOM.getDocument (/pw-editeur) | oui | 1 | {"root":{"nodeId":0,"backendNodeId":0,"childNodeCount":2,"nodeType":9,"nodeName":"#document","localName":"","nodeValue":"","documentURL":"","baseURL":"","xml… |
| DOM.querySelectorAll (#piece) | oui | 0 | {"nodeIds":[37]} |
| DOM.setFileInputFiles | NON | 0 | DOM.setFileInputFiles: DOM.setFileInputFiles is disabled. Restart with `obscura serve --allow-file-access` to enable local file uploads. |
| Runtime.evaluate (fichier choisi ?) | oui | 1 | {"result":{"type":"string","description":"Aucun fichier","value":"Aucun fichier"}} |
|   ↳ fichier joint effectif | NON | 0 | "Aucun fichier" |
| Target.detachFromTarget | oui | 0 | {} |
| Target.closeTarget | oui | 1 | {"success":true} |

| Événement | Reçus |
|---|---|
| Page.frameNavigated | 3 |
| Page.frameStartedLoading | 0 |
| Page.frameStoppedLoading | 3 |
| Page.frameRequestedNavigation | 0 |
| Page.navigatedWithinDocument | 0 |
| Page.frameDetached | 0 |
| Page.loadEventFired | 3 |
| Runtime.executionContextCreated | 6 |
| Runtime.executionContextDestroyed | 0 |
| Runtime.executionContextsCleared | 2 |
| Runtime.consoleAPICalled | 3 |
| Runtime.exceptionThrown | 0 |
| Log.entryAdded | 0 |
| Network.requestWillBeSent | 6 |
| Network.responseReceived | 4 |
| Network.loadingFinished | 4 |
| Network.loadingFailed | 0 |
| Target.attachedToTarget | 3 |
| Target.detachedFromTarget | 3 |
| Fetch.requestPaused | 2 |
| Page.javascriptDialogOpening | 0 |

Autres événements : Target.targetCreated, Page.lifecycleEvent, Page.domContentEventFired, Target.targetInfoChanged, Target.targetDestroyed, DOM.documentUpdated
