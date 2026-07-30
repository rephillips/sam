// Offscreen clipboard writer.
//
// The service worker holds the API token and has no DOM, and the Clipboard API
// needs a document. Routing the write through here means the command that
// carries the real token is assembled and copied entirely inside contexts the
// worker controls, and never passes through the popup.
//
// navigator.clipboard requires focus, which an offscreen document never has,
// so this uses the textarea + execCommand path that offscreen documents are
// designed for.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "offscreenCopy") return;

  const sink = document.getElementById("sink");
  let ok = false;
  try {
    sink.value = String(msg.text || "");
    sink.select();
    ok = document.execCommand("copy");
  } catch (_) {
    ok = false;
  } finally {
    // Do not leave the credential sitting in this document's DOM.
    sink.value = "";
  }

  sendResponse({ ok });
});
