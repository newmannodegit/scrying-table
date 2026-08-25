(() => {
  "use strict";

  const app = document.getElementById("gmLoginApp");
  const form = document.getElementById("gmLoginForm");
  const usernameInput = document.getElementById("gmUsername");
  const passwordInput = document.getElementById("gmPassword");
  const submitButton = document.getElementById("gmLoginButton");
  const message = document.getElementById("gmLoginMessage");
  if (!app || !form || !usernameInput || !passwordInput || !submitButton || !message) return;

  const csrf = app.dataset.csrfToken || "";
  const nextPath = app.dataset.nextPath || "/edit";

  function showError(text) {
    message.textContent = text;
    message.hidden = false;
  }

  function clearError() {
    message.textContent = "";
    message.hidden = true;
  }

  function basicAuthorization(username, password) {
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    return `Basic ${btoa(binary)}`;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    clearError();

    const username = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    if (!username || !password) {
      showError("Enter both the GM username and password.");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Signing in...";

    try {
      const checkResponse = await fetch("/auth/gm/check", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Authorization": basicAuthorization(username, password),
          "Accept": "application/json",
        },
      });

      if (checkResponse.status === 401) {
        throw new Error("Incorrect GM username or password.");
      }

      const checked = await checkResponse.json().catch(() => ({}));
      if (!checkResponse.ok) {
        throw new Error(checked.error || `Login check failed (HTTP ${checkResponse.status}).`);
      }
      if (!checked.ticket) {
        throw new Error("The login check did not return a session ticket.");
      }

      const sessionResponse = await fetch("/auth/gm/session", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Accept": "application/json",
        },
        body: JSON.stringify({ ticket: checked.ticket, next: nextPath }),
      });
      const established = await sessionResponse.json().catch(() => ({}));
      if (!sessionResponse.ok) {
        throw new Error(established.error || `Could not start the GM session (HTTP ${sessionResponse.status}).`);
      }

      window.location.replace(established.next || nextPath || "/edit");
    } catch (error) {
      console.error("GM login failed", error);
      passwordInput.value = "";
      passwordInput.focus();
      showError(error.message || "GM login failed.");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Sign in";
    }
  });
})();
