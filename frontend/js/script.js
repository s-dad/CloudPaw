/* =============================================================================
   CloudPaw — front-end controller (shared by every page)
   The API's address comes from js/config.js (loaded first), so it can differ
   between local and AWS without editing this file.

   Each page sets <body data-page="...">, and the function with that name in
   `pages` below runs (pages without one, like 404.html, get the shared parts
   only: nav, sign-in state and the chat widget).
   ============================================================================= */

// "/api" if js/config.js is missing or its value isn't usable text. A trailing
// "/" is dropped, since paths like "/pets" are added to it.
const configuredApiBase = window.CLOUDPAW_CONFIG?.API_BASE;
const CONFIG = {
  API_BASE: typeof configuredApiBase === "string" && configuredApiBase.trim()
    ? configuredApiBase.trim().replace(/\/+$/, "")
    : "/api",
};

const PLACEHOLDER_IMAGE = "images/placeholder.svg";

const els = {
  navToggle: document.querySelector(".nav-toggle"),
  navLinks: document.getElementById("nav-menu"),
  year: document.getElementById("year"),
};

/* ---------- Utilities ---------- */
const escapeHtml = (str = "") =>
  String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const formatAge = (age) => {
  if (typeof age !== "number") return "Age unknown";
  if (age < 1) return "Under 1 yr";
  return `${age} ${age === 1 ? "yr" : "yrs"}`;
};

const getParam = (name) => new URLSearchParams(window.location.search).get(name) || "";

/* ---------- Data layer ---------- */
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.json();
}

// Pets matching the search text and species (both optional), filtered by the
// API with ?q= and ?species=.
async function fetchPets(query = "", species = "") {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (species) params.set("species", species);
  const search = params.toString();
  return getJson(`${CONFIG.API_BASE}/pets${search ? `?${search}` : ""}`);
}

async function fetchPet(id) {
  const res = await fetch(`${CONFIG.API_BASE}/pets/${encodeURIComponent(id)}`);
  // 404 means "no such pet": return null so the page shows "couldn't find that pet".
  // Any other failure throws, so the page shows "couldn't load this pet right now".
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status}): /pets/${id}`);
  return res.json();
}

// Sends form data to the API.
// On an error response it throws an Error that also carries the API's reply:
// err.status, err.apiMessage (the API's "error" text) and err.fields
// ({ field: message } for each invalid field, empty if none).
async function submitForm(path, data) {
  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`Submit failed (${res.status}): ${path}`);
    err.status = res.status;
    err.apiMessage = typeof body.error === "string" ? body.error : "";
    err.fields = body.fields && typeof body.fields === "object" ? body.fields : {};
    throw err;
  }
}

/* ---------- Auth ---------- */
// Sign-in state from /auth/login or /auth/signup: { token, user }.
// Later requests that need sign-in send it as "Authorization: Bearer <token>".
const AUTH_STORAGE_KEY = "cloudpaw.auth";

// Returns false if the browser blocks storage (e.g. some private modes).
function saveAuth(token, user) {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user }));
    return true;
  } catch {
    return false;
  }
}

// The saved sign-in, { token, user }, or null when signed out (or storage is blocked).
function getAuth() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
    return auth && typeof auth.token === "string" && auth.user ? auth : null;
  } catch {
    return null;
  }
}

function clearAuth() {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing was saved, so nothing to clear.
  }
}

// Header for API routes that need sign-in. Empty when signed out.
function authHeaders() {
  const auth = getAuth();
  return auth ? { Authorization: `Bearer ${auth.token}` } : {};
}

const isAdmin = () => getAuth()?.user.role === "admin";

// Ends the session on the server, forgets it here, and goes to the home page.
// The token is cleared even if the server can't be reached.
async function signOut() {
  const headers = authHeaders();
  clearAuth();
  try {
    await fetch(`${CONFIG.API_BASE}/auth/logout`, { method: "POST", headers });
  } catch (err) {
    console.error(err);
  }
  window.location.href = "index.html";
}

// Asks the API who the saved token belongs to and updates the saved user
// (e.g. a changed role). Returns the user, or null when signed out or the
// session has expired (the stale token is then cleared). If the API can't be
// reached, keeps the saved user rather than signing anyone out.
async function refreshAuth() {
  const auth = getAuth();
  if (!auth) return null;
  try {
    const res = await fetch(`${CONFIG.API_BASE}/auth/me`, { headers: authHeaders() });
    if (res.status === 401) {
      clearAuth();
      return null;
    }
    if (!res.ok) return auth.user;
    const { user } = await res.json();
    saveAuth(auth.token, user);
    return user;
  } catch {
    return auth.user;
  }
}

// Checked once per page load; the nav and admin pages share the result.
let authCheck;
const checkAuth = () => (authCheck ??= refreshAuth());

// Sends the browser to the sign-in page, coming back to this page afterwards.
function goToSignIn() {
  const here = window.location.pathname.split("/").pop() || "index.html";
  window.location.replace(`login.html?next=${encodeURIComponent(here)}`);
}

// For admin pages: shows the page to a signed-in admin and returns true.
// Anyone else is sent to the sign-in page and it returns false.
// (This only hides the page; the API itself refuses non-admins.)
async function requireAdminPage() {
  await checkAuth();
  if (!isAdmin()) {
    goToSignIn();
    return false;
  }
  document.getElementById("main").hidden = false;
  return true;
}

// Where to go after signing in: ?next=<page>.html if given, else the home page.
// Only plain page names are accepted, so the link can't send people off-site.
function pageAfterSignIn() {
  const next = getParam("next");
  return /^[\w-]+\.html$/.test(next) ? next : "index.html";
}

// Nav: "Sign In", or "Hi, Name · Sign out"; admin links only for admins.
function renderAuthNav() {
  const user = getAuth()?.user;
  const admin = isAdmin();
  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.hidden = !admin;
  });
  document.querySelectorAll("[data-auth-nav]").forEach((slot) => {
    slot.innerHTML = user
      ? `<span class="nav-greeting">Hi, ${escapeHtml(user.name)}</span>
         <span aria-hidden="true">·</span>
         <button type="button" class="btn btn-ghost" data-action="sign-out">Sign out</button>`
      : `<a href="login.html" class="btn btn-ghost">Sign In</a>`;
  });
}

// POSTs JSON to an /auth route. Resolves with { ok, body } for any HTTP
// response; only throws if the server can't be reached.
async function postAuth(path, data) {
  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

// Shows a message under a form field and marks the field invalid.
function showFieldError(input, message) {
  const id = `${input.id}-error`;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("p");
    el.id = id;
    el.className = "field-error";
    // A checkbox sits beside its label, so put its message below both.
    if (input.type === "checkbox" && input.parentElement) input.parentElement.append(el);
    else input.insertAdjacentElement("afterend", el);
  }
  el.textContent = message;
  input.setAttribute("aria-invalid", "true");
  input.dataset.prevDescribedby ??= input.getAttribute("aria-describedby") || "";
  input.setAttribute("aria-describedby", `${input.dataset.prevDescribedby} ${id}`.trim());
}

function clearFieldErrors(form) {
  form.querySelectorAll(".field-error").forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid="true"]').forEach((input) => {
    input.removeAttribute("aria-invalid");
    const prev = input.dataset.prevDescribedby;
    if (prev) input.setAttribute("aria-describedby", prev);
    else input.removeAttribute("aria-describedby");
    delete input.dataset.prevDescribedby;
  });
}

// Wires the sign-in or sign-up form: checks it, posts it, shows errors from the
// API on the page, and on success saves the session and goes to the page in
// ?next= (e.g. an admin page that sent them here), or else the home page.
function wireAuthForm({ form, statusEl, path, buildBody, beforeSubmit, onFailure, pendingText }) {
  const setStatus = (message, isError = false) => {
    statusEl.textContent = message;
    statusEl.classList.toggle("status--error", isError);
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    setStatus("");
    beforeSubmit?.();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const submitBtn = form.querySelector("[type=submit]");
    submitBtn.disabled = true;
    setStatus(pendingText);

    try {
      const { ok, body } = await postAuth(path, buildBody());
      if (ok && body.token && body.user) {
        if (!saveAuth(body.token, body.user)) {
          setStatus("Your browser is blocking site storage, so we can't keep you signed in.", true);
          return;
        }
        setStatus(`Welcome, ${body.user.name}!`);
        window.location.href = pageAfterSignIn();
        return;
      }

      // 400 / 401 / 409: show the API's message, plus any per-field messages.
      for (const [field, message] of Object.entries(body.fields || {})) {
        const input = form.elements[field];
        if (input) showFieldError(input, message);
      }
      setStatus(body.error || "Something went wrong. Please try again.", true);
      onFailure?.();
      form.querySelector('[aria-invalid="true"]')?.focus();
    } catch (err) {
      console.error(err);
      setStatus("We couldn't reach the server. Please try again later.", true);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

/* ---------- Rendering ---------- */
const petCardHtml = (pet) => `
  <article class="pet-card">
    <img
      class="pet-card__image"
      src="${escapeHtml(pet.photo_url || PLACEHOLDER_IMAGE)}"
      alt="${escapeHtml(pet.name)} the ${escapeHtml(pet.species)}"
      loading="lazy"
    />
    <div class="pet-card__body">
      <h3 class="pet-card__name">${escapeHtml(pet.name)}</h3>
      <p class="pet-card__meta">
        ${escapeHtml(pet.species)} · ${escapeHtml(pet.breed || "Mixed")} · ${escapeHtml(formatAge(pet.age))}
      </p>
      <p class="pet-card__meta">${escapeHtml(pet.location || "")}</p>
      <a class="btn btn-primary pet-card__cta"
         href="pet.html?id=${encodeURIComponent(pet.id)}">
        Meet ${escapeHtml(pet.name)}
      </a>
    </div>
  </article>`;

// Admins only: change the pet's photo link under the photo (PATCH /api/pets/:id).
// Shows the current link, which for the sample pets is a file on this site.
// novalidate: wirePhotoEdit runs the browser's checks itself, after the
// "unchanged" check, since a site file path isn't a valid https:// link.
const photoEditHtml = (pet) => `
  <form id="photo-edit-form" class="photo-edit" novalidate aria-label="Change ${escapeHtml(pet.name)}'s photo">
    <div class="field">
      <label for="photo-edit-url">Admin: change photo</label>
      <div class="photo-edit__row">
        <input type="url" id="photo-edit-url" name="photo_url" maxlength="2000"
               pattern="https://.*" title="A full link that starts with https://"
               placeholder="https://…" value="${escapeHtml(pet.photo_url || "")}"
               aria-describedby="photo-edit-hint" />
        <button type="submit" class="btn btn-primary">Save photo</button>
      </div>
      <p id="photo-edit-hint" class="field-hint">Paste a link that starts with https://, or clear the box to show the default image.</p>
    </div>
    <p id="photo-edit-status" class="status" role="status" aria-live="polite"></p>
  </form>`;

// An adopted pet's page still loads (old links keep working), but shows that
// the pet has been adopted instead of the Apply button.
const petDetailHtml = (pet) => `
  <article class="pet-detail">
    <div class="pet-detail__media">
      <img
        class="pet-detail__image"
        src="${escapeHtml(pet.photo_url || PLACEHOLDER_IMAGE)}"
        alt="${escapeHtml(pet.name)} the ${escapeHtml(pet.species)}"
      />
      ${isAdmin() ? photoEditHtml(pet) : ""}
    </div>
    <div class="pet-detail__body">
      <p class="eyebrow">${escapeHtml(pet.species)} · ${escapeHtml(pet.breed || "Mixed")}</p>
      <h1>${escapeHtml(pet.name)}</h1>
      <dl class="facts">
        <div><dt>Age</dt><dd>${escapeHtml(typeof pet.age === "number" ? formatAge(pet.age) : "Unknown")}</dd></div>
        <div><dt>Sex</dt><dd>${escapeHtml(pet.sex || "Unknown")}</dd></div>
        <div><dt>Breed</dt><dd>${escapeHtml(pet.breed || "Mixed")}</dd></div>
        <div><dt>Location</dt><dd>${escapeHtml(pet.location || "Unknown")}</dd></div>
      </dl>
      <p>${escapeHtml(pet.description || `${pet.name} is waiting for a loving home.`)}</p>
      ${pet.status === "adopted"
        ? `<p class="notice pet-detail__adopted">
             <span class="badge badge--approved">Adopted</span>
             ${escapeHtml(pet.name)} has found a home and is no longer taking applications.
             <a href="pets.html">Meet the pets still looking for one</a>.
           </p>`
        : `<a class="btn btn-primary" href="adopt.html?pet=${encodeURIComponent(pet.id)}">
             Apply to adopt ${escapeHtml(pet.name)}
           </a>`}
      <a class="back-link" href="pets.html">← Back to all pets</a>
    </div>
  </article>`;

// One row on admin-applications.html, from GET /api/inquiries. Every value
// comes from a public form, so all of it is escaped.
// Statuses with their own badge color in style.css (.badge--pending, …).
const STATUS_BADGES = ["pending", "approved", "denied"];
const applicationRowHtml = (app) => {
  const status = String(app.status || "pending").toLowerCase();
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  const badge = STATUS_BADGES.includes(status) ? `badge--${status}` : "";
  // Clicks are handled by wireApplicationDecisions below (no inline onclick, so
  // the Content-Security-Policy can block inline scripts). Decisions are final,
  // so the buttons are disabled once decided.
  const disabled = status === "pending" ? "" : " disabled";
  const who = escapeHtml(app.name);
  const actions = `
    <button type="button" class="btn-small btn-small--approve" data-action="approve-application"
            aria-label="Approve ${who}'s application"${disabled}>Approve</button>
    <button type="button" class="btn-small btn-small--deny" data-action="deny-application"
            aria-label="Deny ${who}'s application"${disabled}>Deny</button>`;
  return `
    <tr data-application-id="${escapeHtml(String(app.id))}">
      <td data-label="Applicant">${escapeHtml(app.name)}</td>
      <td data-label="Pet" class="data-table__strong">${escapeHtml(app.pet_name || `Pet #${app.pet_id}`)}</td>
      <td data-label="Email" class="muted">${escapeHtml(app.email)}</td>
      <td data-label="Status"><span class="badge ${badge}">${escapeHtml(label)}</span></td>
      <td data-label="Action" class="data-table__actions">${actions}</td>
    </tr>`;
};

// Approve / Deny on admin-applications.html. Asks for confirmation, sends
// PATCH /api/inquiries/:id with the admin's token, then redraws the decided row
// and any rows the server denied automatically (approving one application
// denies the pet's other pending ones). Errors show in the status line.
function wireApplicationDecisions(tbody, statusEl, apps) {
  const byId = new Map(apps.map((app) => [String(app.id), app]));
  const setStatus = (message, isError = false) => {
    statusEl.textContent = message;
    statusEl.classList.toggle("status--error", isError);
  };
  const redraw = (app) => {
    byId.set(String(app.id), app);
    const row = tbody.querySelector(`tr[data-application-id="${CSS.escape(String(app.id))}"]`);
    if (row) row.outerHTML = applicationRowHtml(app);
  };

  tbody.addEventListener("click", async (e) => {
    const button = e.target.closest('[data-action="approve-application"], [data-action="deny-application"]');
    if (!button || button.disabled) return;
    const row = button.closest("tr");
    const app = byId.get(row.dataset.applicationId);
    if (!app) return;

    const decision = button.dataset.action === "approve-application" ? "approved" : "denied";
    const pet = app.pet_name || `Pet #${app.pet_id}`;
    const question = decision === "approved"
      ? `Approve ${app.name}'s application for ${pet}?\n\n${pet} will be marked as adopted, and any other pending applications for ${pet} will be denied. This can't be undone.`
      : `Deny ${app.name}'s application for ${pet}?\n\nThis can't be undone.`;
    if (!window.confirm(question)) return;

    const buttons = row.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    setStatus("Saving…");

    try {
      const res = await fetch(`${CONFIG.API_BASE}/inquiries/${encodeURIComponent(app.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ status: decision }),
      });
      if (res.status === 401 || res.status === 403) {
        // Session expired or no longer an admin: sign in again.
        if (res.status === 401) clearAuth();
        goToSignIn();
        return;
      }
      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        redraw(body.application);
        const autoDenied = body.autoDenied || [];
        for (const id of autoDenied) {
          const other = byId.get(String(id));
          if (other) redraw({ ...other, status: "denied" });
        }
        let message = `${decision === "approved" ? "Approved" : "Denied"} ${app.name}'s application for ${pet}.`;
        if (autoDenied.length) {
          message += ` ${autoDenied.length} other ${autoDenied.length === 1 ? "application" : "applications"} for ${pet} ${autoDenied.length === 1 ? "was" : "were"} denied automatically.`;
        }
        setStatus(message);
        return;
      }

      // 400 / 404 / 409 / 500: show the API's message and let the admin try again.
      let message = body.error || "Could not update the application. Please try again.";
      if (res.status === 409) message += " Refresh the page to see the latest status.";
      setStatus(message, true);
      buttons.forEach((b) => { b.disabled = false; });
    } catch (err) {
      console.error(err);
      setStatus("We couldn't reach the server. Please try again.", true);
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}

// "Admin: change photo" on pet.html. Sends PATCH /api/pets/:id with the admin's
// token and swaps the photo without reloading. Saving an unchanged link sends
// nothing (so the sample pets' site photos can't be wiped by accident), and
// clearing the box asks first. A link that doesn't load shows the default image.
function wirePhotoEdit(pet) {
  const form = document.getElementById("photo-edit-form");
  const input = form.elements.photo_url;
  const button = form.querySelector("[type=submit]");
  const statusEl = document.getElementById("photo-edit-status");
  const image = document.querySelector(".pet-detail__image");
  let current = pet.photo_url || "";
  const setStatus = (message, isError = false) => {
    statusEl.textContent = message;
    statusEl.classList.toggle("status--error", isError);
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    setStatus("");
    const value = input.value.trim();
    if (value === current) {
      setStatus("Nothing to save: the link hasn't changed.");
      return;
    }
    if (!value && !window.confirm(`Remove ${pet.name}'s photo? The default image will show instead.`)) return;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    button.disabled = true;
    setStatus("Saving…");
    try {
      const res = await fetch(`${CONFIG.API_BASE}/pets/${encodeURIComponent(pet.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ photo_url: value }),
      });
      if (res.status === 401 || res.status === 403) {
        // Session expired or no longer an admin: sign in again.
        if (res.status === 401) clearAuth();
        goToSignIn();
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        current = body.photo_url || "";
        input.value = current;
        image.src = current || PLACEHOLDER_IMAGE;
        setStatus(current ? "Photo updated." : "Photo removed. The default image is showing.");
        return;
      }
      if (body.fields?.photo_url) showFieldError(input, body.fields.photo_url);
      setStatus(body.error || "Could not update the photo. Please try again.", true);
    } catch (err) {
      console.error(err);
      setStatus("We couldn't reach the server. Please try again later.", true);
    } finally {
      button.disabled = false;
    }
  });
}

const skeletons = (count) =>
  Array.from({ length: count }).map(() => `<div class="skeleton"></div>`).join("");

// Loads pets into a grid. Used by the home page (featured) and pets.html (all).
async function loadPetGrid({ listEl, statusEl, query = "", species = "", limit = 0 }) {
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

  listEl.setAttribute("aria-busy", "true");
  listEl.innerHTML = skeletons(limit || 6);
  setStatus("Loading pets…");

  try {
    let pets = await fetchPets(query, species);
    if (limit) pets = pets.slice(0, limit);

    if (pets.length === 0) {
      listEl.innerHTML = "";
      setStatus("No pets match your search. Try a different term.");
      return;
    }

    listEl.innerHTML = pets.map(petCardHtml).join("");
    setStatus(limit ? "" : `Showing ${pets.length} ${pets.length === 1 ? "pet" : "pets"}.`);
  } catch (err) {
    console.error(err);
    listEl.innerHTML = "";
    setStatus("Sorry, we couldn't load pets right now. Please try again later.");
  } finally {
    listEl.setAttribute("aria-busy", "false");
  }
}

// Validates a form, sends it, then swaps the form for a thank-you message.
// If the API rejects it, shows the API's message and puts each field's
// message under that field.
function wireForm({ form, path, successEl, statusEl, onSuccess }) {
  const setStatus = (message, isError = false) => {
    statusEl.textContent = message;
    statusEl.classList.toggle("status--error", isError);
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    setStatus("");
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const data = Object.fromEntries(new FormData(form));
    const submitBtn = form.querySelector("[type=submit]");
    submitBtn.disabled = true;
    setStatus("Sending…");

    try {
      await submitForm(path, data);
      onSuccess?.(data);
      form.hidden = true;
      successEl.hidden = false;
      successEl.focus();
      setStatus("");
    } catch (err) {
      console.error(err);
      for (const [field, message] of Object.entries(err.fields || {})) {
        const input = form.elements[field];
        if (input) showFieldError(input, message);
      }
      // No status means the request never got an answer (offline, server down).
      setStatus(
        err.apiMessage ||
          (err.status ? "Sorry, something went wrong. Please try again." : "We couldn't reach the server. Please try again later."),
        true
      );
      form.querySelector('[aria-invalid="true"]')?.focus();
    } finally {
      submitBtn.disabled = false;
    }
  });
}

/* ---------- Pages ---------- */
const pages = {
  home() {
    const listEl = document.getElementById("pet-list");
    loadPetGrid({
      listEl,
      statusEl: document.getElementById("pet-status"),
      limit: Number(listEl.dataset.limit) || 0,
    });
  },

  pets() {
    const query = getParam("q").trim();
    const species = getParam("species");
    document.getElementById("search-input").value = query;
    document.getElementById("species-select").value = species;

    loadPetGrid({
      listEl: document.getElementById("pet-list"),
      statusEl: document.getElementById("pet-status"),
      query,
      species,
    });
  },

  async pet() {
    const container = document.getElementById("pet-detail");
    const statusEl = document.getElementById("pet-status");
    const id = getParam("id");

    try {
      const pet = id ? await fetchPet(id) : null;
      if (!pet) {
        container.innerHTML = "";
        statusEl.innerHTML = `We couldn't find that pet. <a class="back-link" href="pets.html">Browse all pets</a>`;
        return;
      }
      document.title = `${pet.name} | CloudPaw`;
      container.innerHTML = petDetailHtml(pet);
      statusEl.textContent = "";
      if (document.getElementById("photo-edit-form")) wirePhotoEdit(pet);
    } catch (err) {
      console.error(err);
      container.innerHTML = "";
      statusEl.textContent = "Sorry, we couldn't load this pet right now. Please try again later.";
    } finally {
      container.setAttribute("aria-busy", "false");
    }
  },

  async adopt() {
    const form = document.getElementById("adopt-form");
    const select = document.getElementById("adopt-pet");
    const wantedId = getParam("pet");

    try {
      const pets = await fetchPets();
      select.insertAdjacentHTML(
        "beforeend",
        pets
          .map((pet) => `<option value="${escapeHtml(String(pet.id))}">${escapeHtml(pet.name)} (${escapeHtml(pet.species)}, ${escapeHtml(pet.breed || "Mixed")})</option>`)
          .join("")
      );
      if (wantedId) select.value = wantedId;
    } catch (err) {
      console.error(err);
      document.getElementById("adopt-status").textContent =
        "We couldn't load the pet list. Please refresh the page.";
    }

    wireForm({
      form,
      path: "/inquiries",
      successEl: document.getElementById("adopt-success"),
      statusEl: document.getElementById("adopt-status"),
      onSuccess: () => {
        const petName = select.options[select.selectedIndex]?.text.split(" (")[0] || "your pet";
        document.getElementById("adopt-success-pet").textContent = petName;
      },
    });
  },

  about() {
    wireForm({
      form: document.getElementById("contact-form"),
      path: "/messages",
      successEl: document.getElementById("contact-success"),
      statusEl: document.getElementById("contact-status"),
    });
  },

  login() {
    const form = document.getElementById("login-form");
    // Sent here by an admin page (see goToSignIn).
    if (getParam("next")) {
      document.getElementById("login-status").textContent = getAuth()
        ? "That page is for admins only. Sign in with an admin account to continue."
        : "Please sign in to continue.";
    }
    wireAuthForm({
      form,
      statusEl: document.getElementById("login-status"),
      path: "/auth/login",
      pendingText: "Signing in…",
      buildBody: () => ({ email: form.elements.email.value, password: form.elements.password.value }),
      // Wrong email or password: clear the password so it can be retyped.
      onFailure: () => {
        form.elements.password.value = "";
        form.elements.password.focus();
      },
    });
  },

  signup() {
    const form = document.getElementById("signup-form");
    const password = form.elements.password;
    const confirm = form.elements["confirm-password"];

    // The confirm field is checked here only; it is never sent to the API.
    const checkMatch = () =>
      confirm.setCustomValidity(confirm.value && confirm.value !== password.value ? "Passwords don't match." : "");
    password.addEventListener("input", checkMatch);
    confirm.addEventListener("input", checkMatch);

    wireAuthForm({
      form,
      statusEl: document.getElementById("signup-status"),
      path: "/auth/signup",
      pendingText: "Creating your account…",
      beforeSubmit: checkMatch,
      buildBody: () => ({
        name: form.elements.name.value,
        email: form.elements.email.value,
        password: password.value,
      }),
    });
  },

  // Admin: add a pet with POST /api/pets.
  async "admin-add"() {
    if (!(await requireAdminPage())) return;
    const form = document.getElementById("add-pet-form");
    const statusEl = document.getElementById("add-pet-status");
    const submitBtn = form.querySelector("[type=submit]");
    const setStatus = (message, isError = false) => {
      statusEl.textContent = message;
      statusEl.classList.toggle("status--error", isError);
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearFieldErrors(form);
      setStatus("");
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      // Named fields: name, species, breed, age, sex, location, photo_url
      // (the Image URL field) and description.
      const data = Object.fromEntries(new FormData(form));
      submitBtn.disabled = true;
      setStatus("Saving…");

      try {
        const res = await fetch(`${CONFIG.API_BASE}/pets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(data),
        });
        const body = await res.json().catch(() => ({}));

        if (res.status === 401 || res.status === 403) {
          // Session expired or no longer an admin: sign in again.
          if (res.status === 401) clearAuth();
          goToSignIn();
          return;
        }
        if (res.ok) {
          form.reset();
          statusEl.classList.remove("status--error");
          statusEl.innerHTML = `${escapeHtml(body.name)} was added. <a href="pet.html?id=${encodeURIComponent(body.id)}">View their page</a>`;
          return;
        }

        // 400: show each field's message under that field.
        for (const [field, message] of Object.entries(body.fields || {})) {
          const input = form.elements[field];
          if (input) showFieldError(input, message);
        }
        setStatus(body.error || "Could not save the pet. Please try again.", true);
        form.querySelector('[aria-invalid="true"]')?.focus();
      } catch (err) {
        console.error(err);
        setStatus("We couldn't reach the server. Please try again later.", true);
      } finally {
        submitBtn.disabled = false;
      }
    });
  },

  // Admin: list adoption applications from GET /api/inquiries.
  async "admin-applications"() {
    if (!(await requireAdminPage())) return;
    const tbody = document.getElementById("applications-table");
    const statusEl = document.getElementById("applications-status");
    statusEl.textContent = "Loading applications…";

    try {
      const res = await fetch(`${CONFIG.API_BASE}/inquiries`, { headers: authHeaders() });
      if (res.status === 401 || res.status === 403) {
        if (res.status === 401) clearAuth();
        goToSignIn();
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status}): /inquiries`);

      const apps = await res.json();
      tbody.innerHTML = apps.map(applicationRowHtml).join("");
      statusEl.textContent = apps.length
        ? `${apps.length} ${apps.length === 1 ? "application" : "applications"}.`
        : "No applications yet.";
      wireApplicationDecisions(tbody, statusEl, apps);
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Sorry, we couldn't load applications right now. Please try again later.";
      statusEl.classList.add("status--error");
    }
  },

};

/* ---------- Chat widget ("Ask AI", every page) ---------- */
// A floating "Ask AI" button in the bottom-right corner opens a small chat box
// above it. The answers are written here (no AI service is connected).
// The conversation and whether the box is open are kept in sessionStorage, so
// they carry over between pages in the same tab and are cleared when the tab
// closes. Nothing is sent to the server.
const CHAT_STORAGE_KEY = "cloudpaw.chat";
const CHAT_GREETING = "Hi! Ask me about adopting a pet.";
const CHAT_MAX_SAVED = 50; // messages kept between pages

function chatReply(text) {
  const t = text.toLowerCase();
  if (t.includes("luna")) {
    return "Luna is a 2-year-old female Labrador Retriever in Columbus, OH. She is friendly, high-energy, and loves fetching tennis balls!";
  }
  if (t.includes("cat")) {
    return "We currently have Milo and Oliver available. Milo is a laid-back 3-year-old tabby in Cleveland, OH, and Oliver is a gentle 4-year-old Maine Coon in Dayton, OH.";
  }
  return "I can tell you about Luna or our cats. To see every pet, try Find a Pet, or send us a message from the About page.";
}

function loadChat() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_STORAGE_KEY) || "null");
    if (saved && Array.isArray(saved.messages) && saved.messages.length) return saved;
  } catch {
    // Storage blocked or unreadable: start a new conversation.
  }
  return { open: false, messages: [{ from: "bot", text: CHAT_GREETING }] };
}

function saveChat(state) {
  try {
    sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
      open: state.open,
      messages: state.messages.slice(-CHAT_MAX_SAVED),
    }));
  } catch {
    // Storage blocked: the chat still works, it just won't carry over.
  }
}

const PAW_SVG = `
  <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <ellipse cx="32" cy="40" rx="11" ry="9.5"/>
      <ellipse cx="18.5" cy="27" rx="4.5" ry="5.8"/><ellipse cx="27" cy="20" rx="4.5" ry="5.8"/>
      <ellipse cx="37" cy="20" rx="4.5" ry="5.8"/><ellipse cx="45.5" cy="27" rx="4.5" ry="5.8"/>
    </g>
  </svg>`;

function initChatWidget() {
  const widget = document.createElement("div");
  widget.className = "chat-widget";
  widget.innerHTML = `
    <section id="chat-panel" class="chat-panel" role="dialog" aria-labelledby="chat-title" hidden>
      <header class="chat-panel__header">
        ${PAW_SVG}
        <h2 id="chat-title" class="chat-panel__title">CloudPaw assistant</h2>
        <button type="button" class="chat-panel__close" data-chat="close" aria-label="Close chat">×</button>
      </header>
      <div class="chat-panel__messages" role="log" aria-live="polite"></div>
      <form class="chat-panel__form">
        <label class="visually-hidden" for="chat-input">Your message</label>
        <input id="chat-input" name="message" type="text" maxlength="500" autocomplete="off"
               placeholder="Ask about adopting a pet…" />
        <button type="submit" class="btn btn-primary">Send</button>
      </form>
    </section>
    <button type="button" class="chat-launcher" aria-controls="chat-panel" aria-expanded="false">
      ${PAW_SVG}<span>Ask AI</span>
    </button>`;
  document.body.append(widget);

  const panel = widget.querySelector("#chat-panel");
  const launcher = widget.querySelector(".chat-launcher");
  const list = widget.querySelector(".chat-panel__messages");
  const form = widget.querySelector(".chat-panel__form");
  const input = form.elements.message;
  const state = loadChat();

  // Messages are added with textContent, so whatever someone types is shown
  // as plain text.
  const addBubble = ({ from, text }) => {
    const bubble = document.createElement("p");
    bubble.className = `message message--${from === "user" ? "user" : "bot"}`;
    bubble.textContent = text;
    list.append(bubble);
    list.scrollTop = list.scrollHeight;
  };
  const addMessage = (message) => {
    state.messages.push(message);
    addBubble(message);
    saveChat(state);
  };

  const setOpen = (open, { focus = true } = {}) => {
    state.open = open;
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    saveChat(state);
    if (!focus) return;
    if (open) input.focus();
    else launcher.focus();
  };

  state.messages.forEach(addBubble);
  // Reopen on the next page if it was open, without moving the focus there.
  setOpen(state.open, { focus: false });
  list.scrollTop = list.scrollHeight;

  launcher.addEventListener("click", () => setOpen(panel.hidden));
  widget.querySelector('[data-chat="close"]').addEventListener("click", () => setOpen(false));
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMessage({ from: "user", text });
    // A short pause before answering, so the reply doesn't appear instantly.
    setTimeout(() => addMessage({ from: "bot", text: chatReply(text) }), 600);
  });
}

/* ---------- Shared events ---------- */
// "Skip to main content": move keyboard focus to <main> directly. A plain
// href="#main" doesn't work on 404.html, whose <base href="/"> would turn it
// into "/#main" and open the home page.
document.querySelector(".skip-link")?.addEventListener("click", (e) => {
  const main = document.getElementById("main");
  if (!main) return;
  e.preventDefault();
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus();
  main.scrollIntoView();
});

// Swap in the placeholder when a pet photo is missing. Image errors don't
// bubble, so listen in the capture phase.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || img.src.endsWith(PLACEHOLDER_IMAGE)) return;
    img.src = PLACEHOLDER_IMAGE;
  },
  true
);

els.navToggle?.addEventListener("click", () => {
  const open = els.navLinks.classList.toggle("is-open");
  els.navToggle.setAttribute("aria-expanded", String(open));
});

/* ---------- Footer year ---------- */
if (els.year) els.year.textContent = new Date().getFullYear();

// "Sign out" in the nav (rendered by renderAuthNav). Approve/Deny are handled
// by wireApplicationDecisions on admin-applications.html.
document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="sign-out"]')) signOut();
});

/* ---------- Boot ---------- */
// Draw the nav from the saved sign-in right away, then again once the API has
// confirmed it (an expired session switches back to "Sign In").
renderAuthNav();
checkAuth().then(renderAuthNav);
initChatWidget();
pages[document.body.dataset.page]?.();