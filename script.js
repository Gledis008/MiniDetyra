const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "dashboard-users-v2";
const ROLES = ["Admin", "Editor", "Viewer", "Moderator", "Guest"];
const AVATAR_COLORS = ["#6c63ff","#f857a6","#00b09b","#f7971e","#2193b0","#cc2b5e","#e96c4c","#11998e","#8e44ad","#e67e22"];
const UNDO_DELAY = 5000;
const PAGE_SIZE = 8;

let users = [];
let filteredUsers = [];
let selectedIds = new Set();
let searchQuery = "";
let sortMode = "newest";
let currentPage = 1;
let undoStack = [];
let undoTimer = null;
let dragSrcIndex = null;
let editingId = null;
let toastTimer = null;

function loadUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    users = raw ? JSON.parse(raw) : [];
  } catch {
    users = [];
  }
}

function saveUsers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
}

function generateId() {
  return `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getInitials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

function escapeHTML(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return str.replace(/[&<>"']/g, (c) => map[c]);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("sq-AL", { day: "2-digit", month: "short", year: "numeric" });
}

function getAvatarColor(name) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function showToast(message, type = "info") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast toast--${type} toast--visible`;
  toastTimer = setTimeout(() => toast.classList.remove("toast--visible"), 3200);
}

function showHint(message, type = "error") {
  const hint = $("input-hint");
  hint.textContent = message;
  hint.className = `input-hint ${type}`;
  clearTimeout(showHint._t);
  showHint._t = setTimeout(() => { hint.textContent = ""; hint.className = "input-hint"; }, 3000);
}

function applyFiltersAndSort() {
  const q = searchQuery.toLowerCase();
  filteredUsers = users.filter((u) =>
    u.name.toLowerCase().includes(q) ||
    (u.role && u.role.toLowerCase().includes(q)) ||
    (u.email && u.email.toLowerCase().includes(q))
  );
  const sorts = {
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    az: (a, b) => a.name.localeCompare(b.name),
    za: (a, b) => b.name.localeCompare(a.name),
    active: (a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0),
  };
  filteredUsers.sort(sorts[sortMode] ?? sorts.newest);
}

function getPaginatedUsers() {
  const start = (currentPage - 1) * PAGE_SIZE;
  return filteredUsers.slice(start, start + PAGE_SIZE);
}

function getTotalPages() {
  return Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
}

function buildStatsBar() {
  let bar = $("stats-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "stats-bar";
    bar.className = "stats-bar";
    const section = document.querySelector(".users-section");
    section.parentNode.insertBefore(bar, section);
  }
  const total = users.length;
  const active = users.filter((u) => u.active).length;
  const admins = users.filter((u) => u.role === "Admin").length;
  const guests = users.filter((u) => u.role === "Guest").length;
  bar.innerHTML = `
    <div class="stat-card"><span class="stat-num">${total}</span><span class="stat-label">Gjithsej</span></div>
    <div class="stat-card"><span class="stat-num">${active}</span><span class="stat-label">Aktiv</span></div>
    <div class="stat-card"><span class="stat-num">${total - active}</span><span class="stat-label">Joaktiv</span></div>
    <div class="stat-card"><span class="stat-num">${admins}</span><span class="stat-label">Admin</span></div>
    <div class="stat-card"><span class="stat-num">${guests}</span><span class="stat-label">Guest</span></div>
  `;
}

function buildToolbar() {
  if ($("toolbar")) {
    $("search-input").value = searchQuery;
    $("sort-select").value = sortMode;
    return;
  }
  const toolbar = document.createElement("div");
  toolbar.id = "toolbar";
  toolbar.className = "toolbar";
  toolbar.innerHTML = `
    <input type="text" id="search-input" class="input search-input" placeholder="Kerko sipas emrit, rolit, email..." value="${escapeHTML(searchQuery)}" />
    <select id="sort-select" class="sort-select">
      <option value="newest">Me te rinjte</option>
      <option value="oldest">Me te vjetrit</option>
      <option value="az">A → Z</option>
      <option value="za">Z → A</option>
      <option value="active">Aktivet</option>
    </select>
    <button id="bulk-delete-btn" class="btn-bulk-delete" style="display:none">Fshi te zgjedhurat</button>
    <button id="export-btn" class="btn-export">⬇ Eksporto</button>
    <button id="select-all-btn" class="btn-select-all">Zgjidh te gjithe</button>
  `;
  const section = document.querySelector(".users-section");
  section.parentNode.insertBefore(toolbar, section);

  $("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    currentPage = 1;
    render();
  });

  $("sort-select").addEventListener("change", (e) => {
    sortMode = e.target.value;
    currentPage = 1;
    render();
  });

  $("export-btn").addEventListener("click", openExportModal);
  $("bulk-delete-btn").addEventListener("click", bulkDelete);

  $("select-all-btn").addEventListener("click", () => {
    const pageIds = getPaginatedUsers().map((u) => u.id);
    const allSelected = pageIds.every((id) => selectedIds.has(id));
    pageIds.forEach((id) => allSelected ? selectedIds.delete(id) : selectedIds.add(id));
    render();
  });
}

function buildPagination() {
  let pag = $("pagination");
  if (!pag) {
    pag = document.createElement("div");
    pag.id = "pagination";
    pag.className = "pagination";
    document.querySelector(".users-section").appendChild(pag);
  }
  const total = getTotalPages();
  if (total <= 1) { pag.innerHTML = ""; return; }
  let html = `<button class="pag-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>‹</button>`;
  for (let i = 1; i <= total; i++) {
    html += `<button class="pag-btn ${i === currentPage ? "pag-btn--active" : ""}" data-page="${i}">${i}</button>`;
  }
  html += `<button class="pag-btn" data-page="${currentPage + 1}" ${currentPage === total ? "disabled" : ""}>›</button>`;
  pag.innerHTML = html;
  pag.querySelectorAll(".pag-btn:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => { currentPage = parseInt(btn.dataset.page); render(); });
  });
}

function renderUserItem(user, realIndex) {
  const li = document.createElement("li");
  li.className = `user-item${user.active ? "" : " user-item--inactive"}${selectedIds.has(user.id) ? " user-item--selected" : ""}`;
  li.setAttribute("draggable", "true");
  li.dataset.id = user.id;
  li.dataset.index = realIndex;

  const color = getAvatarColor(user.name);
  const initials = getInitials(user.name);

  if (editingId === user.id) {
    li.innerHTML = `
      <div class="user-info">
        <div class="user-avatar" style="background:${color}">${initials}</div>
        <div class="user-edit-form">
          <input type="text" class="input edit-name-input" value="${escapeHTML(user.name)}" maxlength="30" id="edit-name-${user.id}" />
          <input type="text" class="input edit-email-input" value="${escapeHTML(user.email || "")}" placeholder="Email (opsional)" id="edit-email-${user.id}" />
          <select class="sort-select edit-role-select" id="edit-role-${user.id}">
            ${ROLES.map((r) => `<option value="${r}" ${user.role === r ? "selected" : ""}>${r}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="user-actions">
        <button class="btn-save" data-id="${user.id}">✓</button>
        <button class="btn-cancel-edit" data-id="${user.id}">✕</button>
      </div>
    `;
  } else {
    li.innerHTML = `
      <div class="user-check-wrap">
        <input type="checkbox" class="user-checkbox" data-id="${user.id}" ${selectedIds.has(user.id) ? "checked" : ""} />
      </div>
      <div class="user-info">
        <div class="user-avatar" style="background:${color}">${initials}</div>
        <div class="user-details">
          <span class="user-name">${escapeHTML(user.name)}</span>
          ${user.email ? `<span class="user-email">${escapeHTML(user.email)}</span>` : ""}
          <div class="user-meta">
            <span class="user-role role--${(user.role || "Guest").toLowerCase()}">${user.role || "Guest"}</span>
            <span class="user-date">${formatDate(user.createdAt)}</span>
          </div>
        </div>
      </div>
      <div class="user-actions">
        <button class="btn-toggle ${user.active ? "active" : ""}" data-id="${user.id}" title="${user.active ? "Çaktivizo" : "Aktivizo"}">${user.active ? "●" : "○"}</button>
        <button class="btn-edit" data-id="${user.id}" title="Edito">✎</button>
        <button class="btn-delete" data-id="${user.id}" title="Fshi">✕</button>
      </div>
    `;
  }

  li.style.opacity = "0";
  li.style.transform = "translateY(8px)";
  requestAnimationFrame(() => {
    li.style.transition = "opacity 0.25s ease, transform 0.25s ease, background 0.2s";
    li.style.opacity = "1";
    li.style.transform = "translateY(0)";
  });

  li.addEventListener("dragstart", onDragStart);
  li.addEventListener("dragover", onDragOver);
  li.addEventListener("drop", onDrop);
  li.addEventListener("dragend", onDragEnd);

  return li;
}

function render() {
  applyFiltersAndSort();
  buildStatsBar();
  buildToolbar();

  const paginated = getPaginatedUsers();
  userList.innerHTML = "";

  $("empty-state").style.display = filteredUsers.length === 0 ? "flex" : "none";
  userList.style.display = filteredUsers.length === 0 ? "none" : "block";

  paginated.forEach((user) => {
    const realIndex = users.findIndex((u) => u.id === user.id);
    userList.appendChild(renderUserItem(user, realIndex));
  });

  buildPagination();

  $("user-count").textContent = `${users.length} ${users.length === 1 ? "user" : "users"}`;

  const bulkBtn = $("bulk-delete-btn");
  if (bulkBtn) bulkBtn.style.display = selectedIds.size > 0 ? "inline-flex" : "none";

  bindListActions();
  saveUsers();
}

function bindListActions() {
  userList.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteUser(btn.dataset.id));
  });
  userList.querySelectorAll(".btn-edit").forEach((btn) => {
    btn.addEventListener("click", () => { editingId = btn.dataset.id; render(); });
  });
  userList.querySelectorAll(".btn-save").forEach((btn) => {
    btn.addEventListener("click", () => saveEdit(btn.dataset.id));
  });
  userList.querySelectorAll(".btn-cancel-edit").forEach((btn) => {
    btn.addEventListener("click", () => { editingId = null; render(); });
  });
  userList.querySelectorAll(".btn-toggle").forEach((btn) => {
    btn.addEventListener("click", () => toggleActive(btn.dataset.id));
  });
  userList.querySelectorAll(".user-checkbox").forEach((chk) => {
    chk.addEventListener("change", () => {
      chk.checked ? selectedIds.add(chk.dataset.id) : selectedIds.delete(chk.dataset.id);
      render();
    });
  });
  userList.querySelectorAll(".edit-name-input").forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveEdit(editingId);
      if (e.key === "Escape") { editingId = null; render(); }
    });
  });
}

function addUser() {
  const name = $("user-input").value.trim();
  const roleEl = $("role-select");
  const emailEl = $("email-input");

  if (!name) { showHint("Ju lutem shkruani nje emer.", "error"); $("user-input").focus(); return; }
  if (name.length < 2) { showHint("⚠ Emri duhet te kete te pakten 2 karaktere.", "error"); return; }
  if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) { showHint("⚠ Ky perdorues ekziston tashme.", "error"); return; }

  const email = emailEl ? emailEl.value.trim() : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showHint("⚠ Email-i nuk eshte i vlefshem.", "error"); return; }

  users.unshift({
    id: generateId(),
    name,
    email: email || "",
    role: roleEl ? roleEl.value : "Guest",
    active: true,
    createdAt: new Date().toISOString(),
  });

  $("user-input").value = "";
  if (emailEl) emailEl.value = "";
  currentPage = 1;
  showHint("Perdoruesi u shtua me sukses!", "success");
  showToast(`"${name}" u shtua.`, "success");
  render();
}

function deleteUser(id) {
  const index = users.findIndex((u) => u.id === id);
  if (index === -1) return;
  const removed = users.splice(index, 1)[0];
  undoStack.push({ action: "delete", user: removed, index });
  clearTimeout(undoTimer);
  showUndoBanner(removed.name);
  undoTimer = setTimeout(() => { undoStack = []; hideUndoBanner(); }, UNDO_DELAY);
  selectedIds.delete(id);
  render();
}

function bulkDelete() {
  if (selectedIds.size === 0) return;
  const removed = [];
  selectedIds.forEach((id) => {
    const i = users.findIndex((u) => u.id === id);
    if (i !== -1) removed.push({ user: users.splice(i, 1)[0], index: i });
  });
  undoStack.push({ action: "bulk", removed });
  clearTimeout(undoTimer);
  showUndoBanner(`${removed.length} perdorues`);
  undoTimer = setTimeout(() => { undoStack = []; hideUndoBanner(); }, UNDO_DELAY);
  selectedIds.clear();
  showToast(`${removed.length} perdorues u fshine.`, "error");
  render();
}

function undoLast() {
  if (!undoStack.length) return;
  const last = undoStack.pop();
  clearTimeout(undoTimer);
  if (last.action === "delete") {
    users.splice(last.index, 0, last.user);
    showToast(`↩ "${last.user.name}" u rikthye.`, "info");
  } else if (last.action === "bulk") {
    last.removed.sort((a, b) => a.index - b.index).forEach(({ user, index }) => users.splice(index, 0, user));
    showToast(`↩ ${last.removed.length} perdorues u rikthyen.`, "info");
  }
  hideUndoBanner();
  render();
}

function showUndoBanner(label) {
  let banner = $("undo-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "undo-banner";
    banner.className = "undo-banner";
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<span>🗑 "${label}" u fshi.</span><button id="undo-btn">Zhbej</button>`;
  banner.classList.add("undo-banner--visible");
  $("undo-btn").addEventListener("click", undoLast);
}

function hideUndoBanner() {
  const banner = $("undo-banner");
  if (banner) banner.classList.remove("undo-banner--visible");
}

function toggleActive(id) {
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.active = !user.active;
  showToast(`${user.active ? "✓ Aktivizuar" : "✗ Çaktivizuar"}: ${user.name}`, user.active ? "success" : "info");
  render();
}

function saveEdit(id) {
  const user = users.find((u) => u.id === id);
  if (!user) return;
  const nameInput = $(`edit-name-${id}`);
  const emailInput = $(`edit-email-${id}`);
  const roleInput = $(`edit-role-${id}`);
  const newName = nameInput?.value.trim();
  if (!newName || newName.length < 2) { showToast("Emri duhet te kete te pakten 2 karaktere.", "error"); return; }
  if (users.find((u) => u.id !== id && u.name.toLowerCase() === newName.toLowerCase())) { showToast("Ky emer ekziston tashme.", "error"); return; }
  user.name = newName;
  user.email = emailInput?.value.trim() || "";
  user.role = roleInput?.value || user.role;
  editingId = null;
  showToast(`✏ "${user.name}" u perditesua.`, "info");
  render();
}

function openExportModal() {
  let modal = $("export-modal");
  if (modal) { modal.remove(); return; }
  modal = document.createElement("div");
  modal.id = "export-modal";
  modal.className = "export-modal";
  modal.innerHTML = `
    <div class="export-modal-inner">
      <h3>Eksporto te dhenat</h3>
      <p>${users.length} perdorues total</p>
      <button id="export-json-btn" class="btn-add">⬇ JSON</button>
      <button id="export-csv-btn" class="btn-add">⬇ CSV</button>
      <button id="export-close-btn" class="btn-delete">✕ Mbyll</button>
    </div>
  `;
  document.body.appendChild(modal);
  $("export-json-btn").addEventListener("click", exportJSON);
  $("export-csv-btn").addEventListener("click", exportCSV);
  $("export-close-btn").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(users, null, 2)], { type: "application/json" });
  triggerDownload(blob, "users.json");
  showToast("⬇ JSON u eksportua.", "success");
}

function exportCSV() {
  const header = "ID,Emri,Email,Roli,Aktiv,Krijuar\n";
  const rows = users.map((u) => `${u.id},"${u.name}","${u.email || ""}",${u.role || "Guest"},${u.active},${u.createdAt}`).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  triggerDownload(blob, "users.csv");
  showToast("⬇ CSV u eksportua.", "success");
}

function triggerDownload(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  const modal = $("export-modal");
  if (modal) modal.remove();
}

function injectExtraInputs() {
  if ($("email-input")) return;
  const form = document.querySelector(".add-form");

  const emailInput = document.createElement("input");
  emailInput.type = "text";
  emailInput.id = "email-input";
  emailInput.className = "input";
  emailInput.placeholder = "Email (opsional)";

  const roleSelect = document.createElement("select");
  roleSelect.id = "role-select";
  roleSelect.className = "sort-select";
  roleSelect.innerHTML = ROLES.map((r) => `<option value="${r}">${r}</option>`).join("");

  form.insertBefore(roleSelect, $("add-btn"));
  form.insertBefore(emailInput, roleSelect);
}



function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  userList.querySelectorAll(".user-item").forEach((li) => li.classList.remove("drag-over"));
  e.currentTarget.classList.add("drag-over");
}

function onDrop(e) {
  e.preventDefault();
  const targetIndex = parseInt(e.currentTarget.dataset.index);
  if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
  const moved = users.splice(dragSrcIndex, 1)[0];
  users.splice(targetIndex, 0, moved);
  dragSrcIndex = null;
  render();
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  userList.querySelectorAll(".drag-over").forEach((li) => li.classList.remove("drag-over"));
}

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undoLast(); }
    if ((e.ctrlKey || e.metaKey) && e.key === "f") { e.preventDefault(); $("search-input")?.focus(); }
    if (e.key === "Escape" && editingId) { editingId = null; render(); }
    if (e.key === "Escape") { const modal = $("export-modal"); if (modal) modal.remove(); }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") addUser();
  });
}

function init() {
  loadUsers();
  injectExtraInputs();
  setupKeyboardShortcuts();
  render();
  $("add-btn").addEventListener("click", addUser);
  $("user-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addUser(); });
  $("user-input").addEventListener("input", () => {
    const hint = $("input-hint");
    if (hint.classList.contains("error")) { hint.textContent = ""; hint.className = "input-hint"; }
  });
}

init();