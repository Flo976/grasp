# lightpanda — Chrome/124.0.6367.29 (ws://127.0.0.1:9333/)

| Méthode | OK | ms | Réponse |
|---|---|---|---|
| Browser.getVersion | oui | 1 | {"protocolVersion":"1.3","product":"Chrome/124.0.6367.29","revision":"@9e6ded5ac1ff5e38d930ae52bd9aec09bd1a68e4","userAgent":"Mozilla/5.0 (Macintosh; Intel M… |
| Target.getTargets | oui | 0 | {"targetInfos":[]} |
| Target.createTarget | oui | 1 | {"targetId":"FID-0000000001"} |
| Target.attachToTarget | oui | 0 | {"sessionId":"SID-1"} |
| Target.getTargetInfo | oui | 0 | {"targetInfo":{"url":"about:blank","title":"","targetId":"FID-0000000001","attached":true,"type":"page","canAccessOpener":false,"browserContextId":"BID-1"}} |
| Page.enable | oui | 0 | {} |
| DOM.enable | oui | 0 | {} |
| Accessibility.enable | oui | 0 | {} |
| Runtime.enable | oui | 0 | {} |
| Log.enable | oui | 0 | {} |
| Network.enable | oui | 0 | {} |
| Fetch.enable | oui | 0 | {} |
| Target.setAutoAttach (session) | oui | 0 | {} |
| Page.getFrameTree | oui | 0 | {"frameTree":{"frame":{"id":"FID-0000000001","loaderId":"LID-0000000001","url":"about:blank","domainAndRegistry":"","securityOrigin":"://","mimeType":"text/h… |
| Browser.setDownloadBehavior | oui | 0 | {} |
| Page.setDownloadBehavior | NON | 0 | Page.setDownloadBehavior: 'Page.setDownloadBehavior' wasn't found |
| Target.setAutoAttach (navigateur) | oui | 0 | {} |
| Fetch.continueRequest | oui | 0 | {} |
| Page.navigate | oui | 2 | {"frameId":"FID-0000000001","loaderId":"LID-0000000001"} |
| Page.loadEventFired (événement) | oui | 0 | reçu |
| Fetch.requestPaused (événement) | oui | 0 | 1 reçu(s) |
| Fetch.enable (motifs vides, pour la suite) | oui | 0 | {} |
| Page.getNavigationHistory | oui | 0 | {"currentIndex":0,"entries":[{"id":1,"url":"http://127.0.0.1:46211/","userTypedURL":"http://127.0.0.1:46211/","title":"","transitionType":"other"}]} |
| Page.getLayoutMetrics | oui | 1 | {"layoutViewport":{"pageX":0,"pageY":0,"clientWidth":1920,"clientHeight":1080},"visualViewport":{"offsetX":0,"offsetY":0,"pageX":0,"pageY":0,"clientWidth":19… |
| Runtime.evaluate | oui | 0 | {"result":{"type":"string","value":"Inscription\|false\|Lightpanda/1.0"}} |
| Page.createIsolatedWorld | oui | 1 | {"executionContextId":3} |
| Runtime.evaluate (monde isolé) | oui | 0 | {"result":{"type":"number","value":2,"description":"2"}} |
| Accessibility.getFullAXTree | oui | 1 | {"nodes":[{"nodeId":"1","backendDOMNodeId":1,"role":{"type":"role","value":"RootWebArea"},"ignored":false,"name":{"type":"computedString","value":"Inscriptio… |
|   ↳ getFullAXTree : nœuds | oui | 0 | 55 nœuds ; rôles : RootWebArea,none,banner,navigation,link,StaticText,main,heading,form,textbox,combobox,option,checkbox,button,paragraph |
| Accessibility.queryAXTree | oui | 0 | {"nodes":[{"nodeId":"27","backendDOMNodeId":27,"ignored":false,"role":{"type":"role","value":"button"},"name":{"type":"computedString","value":"Valider"},"pr… |
| DOM.getDocument | oui | 0 | {"root":{"nodeId":1,"backendNodeId":1,"localName":"","nodeType":9,"nodeName":"#document","nodeValue":"","documentURL":null,"baseURL":null,"xmlVersion":"","co… |
| DOM.querySelectorAll | oui | 0 | {"nodeIds":[30]} |
| DOM.describeNode | oui | 0 | {"node":{"nodeId":30,"backendNodeId":30,"parentId":22,"attributes":["id","nom","name","nom","required",""],"localName":"input","nodeType":1,"nodeName":"INPUT… |
| DOM.describeNode (backendNodeId) | oui | 0 | {"node":{"nodeId":30,"backendNodeId":30,"parentId":22,"attributes":["id","nom","name","nom","required",""],"localName":"input","nodeType":1,"nodeName":"INPUT… |
| DOM.resolveNode | oui | 0 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","objectId":"2.2.1"}} |
| Runtime.callFunctionOn | oui | 0 | {"result":{"type":"string","value":"INPUT#nom"}} |
| DOM.resolveNode (monde isolé) | oui | 0 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","objectId":"2.3.1"}} |
| Runtime.callFunctionOn (getBoundingClientRect) | oui | 0 | {"result":{"type":"number","value":5,"description":"5"}} |
| Runtime.getProperties | oui | 0 | {"result":[],"internalProperties":[{"name":"[[Prototype]]","value":{"type":"object","className":"HTMLInputElement","description":"HTMLInputElement","objectId… |
| DOM.scrollIntoViewIfNeeded | oui | 0 | {} |
| DOM.getContentQuads | oui | 0 | {"quads":[[15,145,20,145,20,150,15,150]]} |
| DOM.focus | oui | 0 | {} |
| Input.insertText | oui | 0 | {} |
| Input.dispatchKeyEvent | oui | 0 | {} |
| Input.dispatchKeyEvent (keyUp) | oui | 0 | {} |
| Runtime.evaluate (valeur saisie) | oui | 0 | {"result":{"type":"string","value":"Adab"}} |
|   ↳ saisie effective | oui | 0 | "Adab" |
| Runtime.evaluate (boîte #cgu) | oui | 0 | {"result":{"type":"string","value":"{\"x\":30,\"y\":285,\"width\":5,\"height\":5,\"top\":285,\"right\":35,\"bottom\":290,\"left\":30}"}} |
| Input.dispatchMouseEvent (mouseMoved) | oui | 0 | {} |
| Input.dispatchMouseEvent (mousePressed) | oui | 0 | {} |
| Input.dispatchMouseEvent (mouseReleased) | oui | 0 | {} |
| Runtime.evaluate (case cochée ?) | oui | 0 | {"result":{"type":"boolean","value":true}} |
|   ↳ clic souris effectif (case cochée) | oui | 0 | true à (33,288) |
| Runtime.releaseObject | oui | 0 | {} |
| Runtime.releaseObjectGroup | oui | 0 | {} |
| Emulation.setFocusEmulationEnabled | oui | 0 | {} |
| Emulation.setDeviceMetricsOverride | oui | 0 | {} |
| Emulation.clearDeviceMetricsOverride | oui | 0 | {} |
| Network.getCookies | oui | 0 | {"cookies":[]} |
| Page.captureScreenshot | oui | 12 | {"data":"iVBORw0KGgoAAAANSUhEUgAAB4AAAAQ4CAYAAADo08FDAABWKUlEQVR4XuzdT2xmaX0n+tOVYpCIrptNb8CAr5LZmFAE3RnJjBz15t6Ca8LOICct3YXDWCIrk7EEbEzjxSVITq6lXNGjCqnVwHiI… |
|   ↳ capture PNG | oui | 0 | 22 Ko |
| Page.printToPDF | oui | 1 | {"data":"JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MTEgL0ZpbHRlciAvRmxhdGVEZWNvZGUgID4+… |
|   ↳ PDF | oui | 0 | 13 Ko |
| Page.bringToFront | oui | 0 | {} |
| Page.javascriptDialogOpening (événement) | oui | 0 | reçu |
| Page.handleJavaScriptDialog | NON | 0 | Page.handleJavaScriptDialog: No dialog is showing |
| Runtime.runIfWaitingForDebugger | oui | 0 | {} |
| Runtime.evaluate (console/exception/fetch) | oui | 0 | {"result":{"type":"number","value":1,"description":"1"}} |
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
| Runtime.executionContextsCleared | 1 |
| Runtime.consoleAPICalled | 2 |
| Runtime.exceptionThrown | 1 |
| Log.entryAdded | 1 |
| Network.requestWillBeSent | 2 |
| Network.responseReceived | 2 |
| Network.loadingFinished | 2 |
| Network.loadingFailed | 0 |
| Target.attachedToTarget | 1 |
| Target.detachedFromTarget | 1 |
| Fetch.requestPaused | 1 |
| Page.javascriptDialogOpening | 1 |

Autres événements : Target.targetCreated, Page.frameStartedNavigating, DOM.documentUpdated, Page.domContentEventFired, DOM.setChildNodes, Target.targetDestroyed
