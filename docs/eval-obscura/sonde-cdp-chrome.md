# chrome — Chrome/150.0.7871.114 (ws://127.0.0.1:46533/devtools/browser/1a4ff1c7-6882-4b26-bb25-62ef6b8b3300)

| Méthode | OK | ms | Réponse |
|---|---|---|---|
| Browser.getVersion | oui | 1 | {"protocolVersion":"1.3","product":"Chrome/150.0.7871.114","revision":"@f405107495a07cb1bfcf687d4af8d91117098db6","userAgent":"Mozilla/5.0 (X11; Linux x86_64… |
| Target.getTargets | oui | 1 | {"targetInfos":[{"targetId":"32DE3B1EFD5181DAA1C25E0C2BA173C6","type":"service_worker","title":"Service Worker chrome-extension://fignfifoniblkonapihmkfakmlg… |
| Target.createTarget | oui | 5 | {"targetId":"F24C623F724EF8EBA3976DDBCB1D0670"} |
| Target.attachToTarget | oui | 2 | {"sessionId":"8CD0BABFA582E35668E54E97E7F7CBA6"} |
| Target.getTargetInfo | oui | 2 | {"targetInfo":{"targetId":"F24C623F724EF8EBA3976DDBCB1D0670","type":"page","title":"about:blank","url":"about:blank","attached":true,"canAccessOpener":false,… |
| Page.enable | oui | 2 | {} |
| DOM.enable | oui | 1 | {} |
| Accessibility.enable | oui | 1 | {} |
| Runtime.enable | oui | 1 | {} |
| Log.enable | oui | 1 | {} |
| Network.enable | oui | 1 | {} |
| Fetch.enable | oui | 1 | {} |
| Target.setAutoAttach (session) | oui | 1 | {} |
| Page.getFrameTree | oui | 1 | {"frameTree":{"frame":{"id":"F24C623F724EF8EBA3976DDBCB1D0670","loaderId":"79E54B49C18E6C4CCA38D0883D6486A3","url":"about:blank","domainAndRegistry":"","secu… |
| Browser.setDownloadBehavior | oui | 0 | {} |
| Page.setDownloadBehavior | oui | 0 | {} |
| Target.setAutoAttach (navigateur) | oui | 1 | {} |
| Fetch.continueRequest | oui | 0 | {} |
| Page.navigate | oui | 52 | {"frameId":"F24C623F724EF8EBA3976DDBCB1D0670","loaderId":"A6F09F426DCCD09B1369B5620BD40949","isDownload":false} |
| Page.loadEventFired (événement) | oui | 0 | reçu |
| Fetch.requestPaused (événement) | oui | 0 | 1 reçu(s) |
| Fetch.enable (motifs vides, pour la suite) | oui | 9 | {} |
| Page.getNavigationHistory | oui | 1 | {"currentIndex":1,"entries":[{"id":7,"url":"about:blank","userTypedURL":"about:blank","title":"","transitionType":"auto_toplevel"},{"id":10,"url":"http://127… |
| Page.getLayoutMetrics | oui | 0 | {"layoutViewport":{"pageX":0,"pageY":0,"clientWidth":780,"clientHeight":493},"visualViewport":{"offsetX":0,"offsetY":0,"pageX":0,"pageY":0,"clientWidth":780,… |
| Runtime.evaluate | oui | 1 | {"result":{"type":"string","value":"Inscription\|false\|Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/… |
| Page.createIsolatedWorld | oui | 1 | {"executionContextId":3} |
| Runtime.evaluate (monde isolé) | oui | 0 | {"result":{"type":"number","value":2,"description":"2"}} |
| Accessibility.getFullAXTree | oui | 2 | {"nodes":[{"nodeId":"26","ignored":false,"role":{"type":"internalRole","value":"RootWebArea"},"chromeRole":{"type":"internalRole","value":144},"name":{"type"… |
|   ↳ getFullAXTree : nœuds | oui | 0 | 58 nœuds ; rôles : RootWebArea,none,banner,main,navigation,heading,form,paragraph,button,link,StaticText,generic,InlineTextBox,LabelText,textbox,combobox,checkbox,MenuListPopup,option |
| Accessibility.queryAXTree | oui | 3 | {"nodes":[{"nodeId":"66","ignored":false,"role":{"type":"role","value":"button"},"chromeRole":{"type":"internalRole","value":9},"name":{"type":"computedStrin… |
| DOM.getDocument | oui | 1 | {"root":{"nodeId":1,"backendNodeId":26,"nodeType":9,"nodeName":"#document","localName":"","nodeValue":"","childNodeCount":2,"children":[{"nodeId":2,"parentId… |
| DOM.querySelectorAll | oui | 1 | {"nodeIds":[22]} |
| DOM.describeNode | oui | 1 | {"node":{"nodeId":22,"backendNodeId":21,"nodeType":1,"nodeName":"INPUT","localName":"input","nodeValue":"","childNodeCount":0,"attributes":["id","nom","name"… |
| DOM.describeNode (backendNodeId) | oui | 0 | {"node":{"nodeId":22,"backendNodeId":21,"nodeType":1,"nodeName":"INPUT","localName":"input","nodeValue":"","childNodeCount":0,"attributes":["id","nom","name"… |
| DOM.resolveNode | oui | 1 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","description":"input#nom","objectId":"-8050681761107849139.2.1"}} |
| Runtime.callFunctionOn | oui | 0 | {"result":{"type":"string","value":"INPUT#nom"}} |
| DOM.resolveNode (monde isolé) | oui | 1 | {"object":{"type":"object","subtype":"node","className":"HTMLInputElement","description":"input#nom","objectId":"-8050681761107849139.3.1"}} |
| Runtime.callFunctionOn (getBoundingClientRect) | oui | 0 | {"result":{"type":"number","value":185,"description":"185"}} |
| Runtime.getProperties | oui | 1 | {"result":[],"internalProperties":[{"name":"[[Prototype]]","value":{"type":"object","className":"HTMLInputElement","description":"HTMLInputElement","objectId… |
| DOM.scrollIntoViewIfNeeded | oui | 0 | {} |
| DOM.getContentQuads | oui | 0 | {"quads":[[44,105.875,229,105.875,229,126.875,44,126.875]]} |
| DOM.focus | oui | 1 | {} |
| Input.insertText | oui | 1 | {} |
| Input.dispatchKeyEvent | oui | 2 | {} |
| Input.dispatchKeyEvent (keyUp) | oui | 0 | {} |
| Runtime.evaluate (valeur saisie) | oui | 0 | {"result":{"type":"string","value":"Adab"}} |
|   ↳ saisie effective | oui | 0 | "Adab" |
| Runtime.evaluate (boîte #cgu) | oui | 0 | {"result":{"type":"string","value":"{\"x\":12,\"y\":190.875,\"width\":13,\"height\":13,\"top\":190.875,\"right\":25,\"bottom\":203.875,\"left\":12}"}} |
| Input.dispatchMouseEvent (mouseMoved) | oui | 17 | {} |
| Input.dispatchMouseEvent (mousePressed) | oui | 1 | {} |
| Input.dispatchMouseEvent (mouseReleased) | oui | 1 | {} |
| Runtime.evaluate (case cochée ?) | oui | 0 | {"result":{"type":"boolean","value":true}} |
|   ↳ clic souris effectif (case cochée) | oui | 0 | true à (19,197) |
| Runtime.releaseObject | oui | 0 | {} |
| Runtime.releaseObjectGroup | oui | 0 | {} |
| Emulation.setFocusEmulationEnabled | oui | 0 | {} |
| Emulation.setDeviceMetricsOverride | oui | 1 | {} |
| Emulation.clearDeviceMetricsOverride | oui | 1 | {} |
| Network.getCookies | oui | 1 | {"cookies":[]} |
| Page.captureScreenshot | oui | 33 | {"data":"iVBORw0KGgoAAAANSUhEUgAAAwwAAAHtCAIAAAA7mm4iAAAQAElEQVR4nOzdD8wc9Z3n+XqMmacYkulCe8NTSIldvgRcOo1xjQROZcYOFYGHTkyODuE2RTKIZhhdGub20mFOcnu0ujR7q6Os24OO… |
|   ↳ capture PNG | oui | 0 | 14 Ko |
| Page.printToPDF | oui | 13 | {"data":"JVBERi0xLjQKJdPr6eEKMSAwIG9iago8PC9UaXRsZSAoSW5zY3JpcHRpb24pCi9DcmVhdG9yIChNb3ppbGxhLzUuMCBcKFgxMTsgTGludXggeDg2XzY0XCkgQXBwbGVXZWJLaXQvNTM3LjM2IFwo… |
|   ↳ PDF | oui | 0 | 29 Ko |
| Page.bringToFront | oui | 0 | {} |
| Page.javascriptDialogOpening (événement) | oui | 0 | reçu |
| Page.handleJavaScriptDialog | oui | 3 | {} |
| Runtime.runIfWaitingForDebugger | oui | 1 | {} |
| Runtime.evaluate (console/exception/fetch) | oui | 1 | {"result":{"type":"number","value":1,"description":"1"}} |
| Target.getTargets (2e connexion) | oui | 0 | ["32DE3B1EFD5181DAA1C25E0C2BA173C6:service_worker:chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js","F24C623F724EF8EBA3976DDBCB1D0670:pa… |
| Target.attachToTarget (2e connexion) | oui | 0 | "/\|Adab" |
| Target.createTarget (2e onglet) | oui | 6 | {"targetId":"588DADD9433ED216C62AD328FE1B3E29"} |
| Target.closeTarget (2e onglet) | oui | 3 | {"success":true} |
| Fetch.disable (pour la suite) | oui | 5 | {} |
| Page.navigate (/pw-editeur) | oui | 4 | {"frameId":"F24C623F724EF8EBA3976DDBCB1D0670","loaderId":"DE20AFA0C34EAF27E267B42D61F61771","isDownload":false} |
| DOM.getDocument (/pw-editeur) | oui | 2 | {"root":{"nodeId":1,"backendNodeId":106,"nodeType":9,"nodeName":"#document","localName":"","nodeValue":"","childNodeCount":2,"children":[{"nodeId":2,"parentI… |
| DOM.querySelectorAll (#piece) | oui | 0 | {"nodeIds":[33]} |
| DOM.setFileInputFiles | oui | 2 | {} |
| Runtime.evaluate (fichier choisi ?) | oui | 1 | {"result":{"type":"string","value":"Fichier : sonde-piece.txt"}} |
|   ↳ fichier joint effectif | oui | 0 | "Fichier : sonde-piece.txt" |
| Target.detachFromTarget | oui | 0 | {} |
| Target.closeTarget | oui | 0 | {"success":true} |

| Événement | Reçus |
|---|---|
| Page.frameNavigated | 2 |
| Page.frameStartedLoading | 2 |
| Page.frameStoppedLoading | 2 |
| Page.frameRequestedNavigation | 0 |
| Page.navigatedWithinDocument | 0 |
| Page.frameDetached | 0 |
| Page.loadEventFired | 2 |
| Runtime.executionContextCreated | 5 |
| Runtime.executionContextDestroyed | 0 |
| Runtime.executionContextsCleared | 4 |
| Runtime.consoleAPICalled | 2 |
| Runtime.exceptionThrown | 1 |
| Log.entryAdded | 1 |
| Network.requestWillBeSent | 5 |
| Network.responseReceived | 5 |
| Network.loadingFinished | 5 |
| Network.loadingFailed | 0 |
| Target.attachedToTarget | 6 |
| Target.detachedFromTarget | 3 |
| Fetch.requestPaused | 1 |
| Page.javascriptDialogOpening | 1 |

Autres événements : Inspector.workerScriptLoaded, Page.frameStartedNavigating, Network.requestWillBeSentExtraInfo, Network.responseReceivedExtraInfo, Network.policyUpdated, DOM.documentUpdated, Network.dataReceived, Page.domContentEventFired, Accessibility.loadComplete, DOM.childNodeInserted, DOM.characterDataModified, Page.frameResized, DOM.scrollableFlagUpdated, Page.javascriptDialogClosed, Accessibility.nodesUpdated, Inspector.detached, DOM.childNodeRemoved
