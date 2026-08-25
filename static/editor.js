(() => {
  "use strict";

  const app = document.getElementById("editorApp");
  const csrf = app.dataset.csrfToken;
  const uploadForm = document.getElementById("uploadForm");
  const imageInput = document.getElementById("imageInput");
  const mapNameInput = document.getElementById("mapNameInput");
  const mapLibraryList = document.getElementById("mapLibraryList");
  const mapLibraryCount = document.getElementById("mapLibraryCount");
  const zoomSlider = document.getElementById("zoomSlider");
  const zoomValue = document.getElementById("zoomValue");
  const zoomIn = document.getElementById("zoomInButton");
  const zoomOut = document.getElementById("zoomOutButton");
  const fitButton = document.getElementById("fitButton");
  const clearButton = document.getElementById("clearButton");
  const background = document.getElementById("backgroundSelect");
  const gridEnabled = document.getElementById("gridEnabled");
  const gridSizeSlider = document.getElementById("gridSizeSlider");
  const gridSizeValue = document.getElementById("gridSizeValue");
  const gridColor = document.getElementById("gridColor");
  const gridOpacitySlider = document.getElementById("gridOpacitySlider");
  const gridOpacityValue = document.getElementById("gridOpacityValue");
  const previewPanel = document.getElementById("previewPanel");
  const expandPreviewButton = document.getElementById("expandPreviewButton");
  const gmPreviewDarkness = document.getElementById("gmPreviewDarkness");
  const previewStage = document.getElementById("previewStage");
  const previewContent = document.getElementById("previewContent");
  const previewImage = document.getElementById("previewImage");
  const previewDarknessLayer = document.getElementById("previewDarknessLayer");
  const previewGridLayer = document.getElementById("previewGridLayer");
  const previewAreaLayer = document.getElementById("previewAreaLayer");
  const previewTokenLayer = document.getElementById("previewTokenLayer");
  const filenameLabel = document.getElementById("filenameLabel");
  const message = document.getElementById("statusMessage");
  const vttPasswordForm = document.getElementById("vttPasswordForm");
  const vttPassword = document.getElementById("vttPassword");
  const vttPasswordConfirm = document.getElementById("vttPasswordConfirm");
  const vttPasswordStatus = document.getElementById("vttPasswordStatus");
  const clearVttPassword = document.getElementById("clearVttPasswordButton");
  const tokensVisible = document.getElementById("tokensVisible");
  const movementEnabled = document.getElementById("movementEnabled");
  const darkEnvironment = document.getElementById("darkEnvironment");
  const stackPlayerVision = document.getElementById("stackPlayerVision");
  const persistentExploredFog = document.getElementById("persistentExploredFog");
  const tokenSizeSlider = document.getElementById("tokenSizeSlider");
  const tokenSizeValue = document.getElementById("tokenSizeValue");
  const mobileTokenSizeSlider = document.getElementById("mobileTokenSizeSlider");
  const mobileTokenSizeValue = document.getElementById("mobileTokenSizeValue");
  const addTokenForm = document.getElementById("addTokenForm");
  const newTokenName = document.getElementById("newTokenName");
  const newTokenColor = document.getElementById("newTokenColor");
  const newTokenInitiative = document.getElementById("newTokenInitiative");
  const newTokenVisible = document.getElementById("newTokenVisible");
  const newTokenPlayerControlled = document.getElementById("newTokenPlayerControlled");
  const newMovedByTokenId = document.getElementById("newMovedByTokenId");
  const tokenList = document.getElementById("tokenList");
  const initiativeEnforced = document.getElementById("initiativeEnforced");
  const initiativePreviousButton = document.getElementById("initiativePreviousButton");
  const initiativeNextButton = document.getElementById("initiativeNextButton");
  const activeInitiativeLabel = document.getElementById("activeInitiativeLabel");
  const clearInitiativeButton = document.getElementById("clearInitiativeButton");
  const initiativeList = document.getElementById("initiativeList");
  const playerConnectionLog = document.getElementById("playerConnectionLog");
  const playerMoveLog = document.getElementById("playerMoveLog");
  const addAreaForm = document.getElementById("addAreaForm");
  const newAreaName = document.getElementById("newAreaName");
  const newAreaShape = document.getElementById("newAreaShape");
  const newAreaColor = document.getElementById("newAreaColor");
  const newAreaDiameter = document.getElementById("newAreaDiameter");
  const newAreaLength = document.getElementById("newAreaLength");
  const newAreaAngle = document.getElementById("newAreaAngle");
  const newAreaRotation = document.getElementById("newAreaRotation");
  const newAreaCircleSettings = document.getElementById("newAreaCircleSettings");
  const newAreaConeSettings = document.getElementById("newAreaConeSettings");
  const newAreaLineSettings = document.getElementById("newAreaLineSettings");
  const newAreaLineLength = document.getElementById("newAreaLineLength");
  const newAreaLineWidth = document.getElementById("newAreaLineWidth");
  const newAreaLineRotation = document.getElementById("newAreaLineRotation");
  const addAreaButton = document.getElementById("addAreaButton");
  const areaList = document.getElementById("areaList");

  let state = null;
  let imageVersion = null;
  let displaySaveTimer = null;
  let vttSaveTimer = null;
  let drag = null;
  let previewPanDrag = null;
  let previewWorkspacePan = { x: 0, y: 0 };
  let gmPreviewDarknessVisible = true;
  const PREVIEW_WORKSPACE_ZOOM = 2;

  function showStatus(text, kind = "success") {
    message.textContent = text;
    message.className = `message ${kind}`;
    message.hidden = false;
  }

  function handleGmAuthFailure(response, payload = {}) {
    if (response.status !== 401) return false;
    window.location.assign(payload.login_url || "/login?next=/edit");
    return true;
  }

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}), "X-CSRF-Token": csrf };
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (handleGmAuthFailure(response, payload)) throw new Error("GM login is required.");
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  const tokenAutosavers = new Map();
  const areaAutosavers = new Map();

  function createCardAutosaver(statusElement, saveRequest, onSaved) {
    let timer = null;
    let inFlight = null;
    let revision = 0;
    let dirty = false;
    let disabled = false;

    function setStatus(text, stateName = "") {
      statusElement.textContent = text;
      statusElement.dataset.state = stateName;
    }

    function run() {
      if (disabled || !dirty) return inFlight || Promise.resolve();
      if (inFlight) return inFlight;

      const requestRevision = revision;
      dirty = false;
      setStatus("Saving...", "saving");
      inFlight = (async () => {
        try {
          const result = await saveRequest();
          if (!disabled && requestRevision === revision && !dirty) {
            onSaved(result);
            setStatus("Saved", "saved");
          }
        } catch (error) {
          if (!disabled && requestRevision === revision && !dirty) {
            setStatus("Save failed", "error");
            statusElement.title = error.message;
            showStatus(error.message, "error");
          }
        } finally {
          inFlight = null;
          if (!disabled && dirty) {
            clearTimeout(timer);
            timer = setTimeout(run, 0);
          }
        }
      })();
      return inFlight;
    }

    function schedule(delay = 550) {
      if (disabled) return;
      revision += 1;
      dirty = true;
      statusElement.title = "";
      setStatus(delay === 0 ? "Saving..." : "Unsaved", delay === 0 ? "saving" : "pending");
      clearTimeout(timer);
      timer = setTimeout(run, Math.max(0, delay));
    }

    async function flushNow() {
      if (disabled) return;
      clearTimeout(timer);
      timer = null;
      if (dirty) run();
      await waitForIdle();
    }

    async function waitForIdle() {
      while (inFlight || dirty) {
        if (!inFlight && dirty) run();
        if (inFlight) {
          try {
            await inFlight;
          } catch (_) {
          }
        }
      }
    }

    function cancel() {
      disabled = true;
      dirty = false;
      clearTimeout(timer);
      timer = null;
    }

    function isBusy() {
      return Boolean(inFlight || dirty || timer);
    }

    return { schedule, flushNow, waitForIdle, cancel, isBusy };
  }

  function cardAutosaveBusy() {
    return [...tokenAutosavers.values(), ...areaAutosavers.values()].some(controller => controller.isBusy());
  }

  async function flushCardAutosaves() {
    const controllers = [...tokenAutosavers.values(), ...areaAutosavers.values()];
    await Promise.all(controllers.map(controller => controller.flushNow()));
  }

  function playerTokenChoices(excludeTokenId = null) {
    return (state?.tokens || [])
      .filter(token => token.player_controlled && token.player_key && token.id !== excludeTokenId)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
  }

  function populateDelegateSelect(select, selectedId = "", excludeTokenId = null) {
    if (!select) return;
    const previous = selectedId ?? select.value ?? "";
    select.replaceChildren();
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "Nobody / GM only";
    select.appendChild(noneOption);
    for (const token of playerTokenChoices(excludeTokenId)) {
      const option = document.createElement("option");
      option.value = token.id;
      option.textContent = token.name;
      select.appendChild(option);
    }
    select.value = previous;
    if (select.value !== previous) select.value = "";
  }

  function previewIsExpanded() {
    return previewPanel.classList.contains("preview-expanded");
  }

  function clampPreviewWorkspacePan() {
    if (!previewIsExpanded()) {
      previewWorkspacePan = { x: 0, y: 0 };
      return;
    }
    const maxX = Math.max(0, (previewContent.clientWidth - previewStage.clientWidth) / 2);
    const maxY = Math.max(0, (previewContent.clientHeight - previewStage.clientHeight) / 2);
    previewWorkspacePan.x = Math.max(-maxX, Math.min(maxX, previewWorkspacePan.x));
    previewWorkspacePan.y = Math.max(-maxY, Math.min(maxY, previewWorkspacePan.y));
  }

  function applyPreviewTransform() {
    if (!state) return;
    if (previewIsExpanded()) {
      clampPreviewWorkspacePan();
      previewContent.style.transform = `translate(${previewWorkspacePan.x}px, ${previewWorkspacePan.y}px)`;
    } else {
      previewContent.style.transform = `scale(${Number(state.zoom) || 1})`;
    }
  }

  function setPreviewExpanded(expanded) {
    previewPanDrag = null;
    previewWorkspacePan = { x: 0, y: 0 };
    previewStage.classList.remove("panning");
    previewPanel.classList.toggle("preview-expanded", expanded);
    document.body.classList.toggle("preview-expanded-open", expanded);
    expandPreviewButton.textContent = expanded ? "Restore editor" : "Enlarge map";
    expandPreviewButton.setAttribute("aria-pressed", expanded ? "true" : "false");
    expandPreviewButton.setAttribute("aria-label", expanded ? "Restore normal editor layout" : "Enlarge the GM map preview");
    const panHint = document.getElementById("previewPanHint");
    if (panHint) panHint.hidden = !expanded;
    requestAnimationFrame(() => requestAnimationFrame(fitPreview));
  }

  function fitPreview() {
    if (!state || !state.has_image || !previewImage.naturalWidth || !previewImage.naturalHeight) return;
    if (!previewStage.clientWidth || !previewStage.clientHeight) return;

    const widthScale = previewStage.clientWidth / previewImage.naturalWidth;
    const heightScale = previewStage.clientHeight / previewImage.naturalHeight;
    const fitScale = Math.min(widthScale, heightScale);

    const mapScale = previewIsExpanded()
      ? fitScale * Math.max(PREVIEW_WORKSPACE_ZOOM, Number(state.zoom) || 1)
      : Math.min(1, fitScale);

    previewContent.style.width = `${Math.max(1, previewImage.naturalWidth * mapScale)}px`;
    previewContent.style.height = `${Math.max(1, previewImage.naturalHeight * mapScale)}px`;
    applyPreviewTransform();
    previewContent.hidden = false;
    renderPreviewDarkness();
    renderPreviewGrid();
    renderPreviewAreas();
    renderPreviewTokens();
  }

  function beginPreviewPan(event) {
    if (!previewIsExpanded() || event.button !== 0) return;
    if (event.target.closest(".map-token, .admin-area")) return;
    event.preventDefault();
    previewPanDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: previewWorkspacePan.x,
      startPanY: previewWorkspacePan.y,
    };
    previewStage.setPointerCapture(event.pointerId);
    previewStage.classList.add("panning");
  }

  function movePreviewPan(event) {
    if (!previewPanDrag || previewPanDrag.pointerId !== event.pointerId) return;
    previewWorkspacePan.x = previewPanDrag.startPanX + event.clientX - previewPanDrag.startClientX;
    previewWorkspacePan.y = previewPanDrag.startPanY + event.clientY - previewPanDrag.startClientY;
    applyPreviewTransform();
  }

  function endPreviewPan(event) {
    if (!previewPanDrag || previewPanDrag.pointerId !== event.pointerId) return;
    previewPanDrag = null;
    previewStage.classList.remove("panning");
    if (previewStage.hasPointerCapture(event.pointerId)) previewStage.releasePointerCapture(event.pointerId);
  }

  function activeVisionBlockers() {
    return (state?.vision_blockers || []).filter(blocker =>
      blocker.type === "wall" || (blocker.type === "door" && !blocker.open)
    );
  }

  function cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  function raySegmentDistance(ox, oy, dx, dy, segment, maxDistance) {
    const [x1, y1, x2, y2] = segment;
    const sx = x2 - x1;
    const sy = y2 - y1;
    const denominator = cross(dx, dy, sx, sy);
    if (Math.abs(denominator) < 1e-9) return null;
    const qx = x1 - ox;
    const qy = y1 - oy;
    const rayT = cross(qx, qy, sx, sy) / denominator;
    const segmentU = cross(qx, qy, dx, dy) / denominator;
    if (rayT <= 1e-7 || rayT > maxDistance + 1e-9) return null;
    if (segmentU < -1e-9 || segmentU > 1 + 1e-9) return null;
    return rayT;
  }

  function editorVisibilityPoints(source) {
    const blockers = activeVisionBlockers();
    if (!blockers.length || !previewContent.clientWidth || !previewContent.clientHeight) return null;
    const aspect = previewContent.clientHeight / previewContent.clientWidth;
    const gridFraction = Math.max(0.01, Number(state.grid_size) || 0.05);
    const radius = gridFraction * ((Number(source.radius_feet) || 60) / 5);
    const ox = Number(source.x) || 0;
    const oy = (Number(source.y) || 0) * aspect;
    const segments = blockers.map(blocker => [
      Number(blocker.x1), Number(blocker.y1) * aspect,
      Number(blocker.x2), Number(blocker.y2) * aspect,
    ]);
    const angles = Array.from({ length: 128 }, (_, index) => 2 * Math.PI * index / 128);
    for (const [x1, y1, x2, y2] of segments) {
      for (const [px, py] of [[x1, y1], [x2, y2]]) {
        const angle = Math.atan2(py - oy, px - ox);
        const fullTurn = 2 * Math.PI;
        angles.push(
          (angle - 1e-5 + fullTurn) % fullTurn,
          (angle + fullTurn) % fullTurn,
          (angle + 1e-5 + fullTurn) % fullTurn,
        );
      }
    }
    angles.sort((a, b) => a - b);
    return angles.map(angle => {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      let distance = radius;
      for (const segment of segments) {
        const hit = raySegmentDistance(ox, oy, dx, dy, segment, radius);
        if (hit !== null && hit < distance) distance = hit;
      }
      return [
        Math.min(1, Math.max(0, ox + dx * distance)),
        Math.min(1, Math.max(0, (oy + dy * distance) / aspect)),
      ];
    });
  }

  function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = Number(points[i][0]);
      const yi = Number(points[i][1]);
      const xj = Number(points[j][0]);
      const yj = Number(points[j][1]);
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }

  function editorVisionSources() {
    return (state?.tokens || [])
      .filter(token => {
        const sharedNpcVision = !token.player_controlled
          && Boolean(token.moved_by_token_id)
          && Boolean(token.share_vision_with_controller);
        return token.visible !== false && (
          (token.player_controlled && token.vision_enabled) ||
          sharedNpcVision ||
          (!token.player_controlled && token.reveal_in_darkness)
        );
      })
      .map(token => {
        const sharedNpcVision = !token.player_controlled
          && Boolean(token.moved_by_token_id)
          && Boolean(token.share_vision_with_controller);
        const realVisionSource = Boolean(token.player_controlled || sharedNpcVision);
        const source = {
          token_id: token.id,
          x: token.x,
          y: token.y,
          radius_feet: realVisionSource ? Number(token.vision_radius_feet || 60) : 1,
          vision_type: realVisionSource ? (token.vision_type || "light") : "light",
          player_source: realVisionSource,
        };
        if (realVisionSource) source.points = editorVisibilityPoints(source);
        return source;
      });
  }

  function renderPreviewDarkness() {
    previewDarknessLayer.replaceChildren();
    if (!state || !state.dark_environment || !gmPreviewDarknessVisible || !previewContent.clientWidth || !previewContent.clientHeight) {
      previewDarknessLayer.hidden = true;
      return;
    }

    const width = previewContent.clientWidth;
    const height = previewContent.clientHeight;
    const ns = "http://www.w3.org/2000/svg";
    const maskId = "editorDarknessMask";
    const nightMaskId = "editorNightvisionMask";
    const grayFilterId = "editorNightvisionGray";
    const sources = editorVisionSources();
    const nightSources = sources.filter(source => source.vision_type === "nightvision");
    const lightSources = sources.filter(source => source.vision_type !== "nightvision");
    previewDarknessLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    previewDarknessLayer.setAttribute("preserveAspectRatio", "none");

    const defs = document.createElementNS(ns, "defs");
    const grayFilter = document.createElementNS(ns, "filter");
    grayFilter.setAttribute("id", grayFilterId);
    grayFilter.setAttribute("color-interpolation-filters", "sRGB");
    const grayMatrix = document.createElementNS(ns, "feColorMatrix");
    grayMatrix.setAttribute("type", "saturate");
    grayMatrix.setAttribute("values", "0");
    grayFilter.appendChild(grayMatrix);
    defs.appendChild(grayFilter);

    const gridFraction = Math.max(0.01, Number(state.grid_size) || 0.05);
    const addVisionRegion = (parent, source, fill) => {
      if (Array.isArray(source.points) && source.points.length >= 3) {
        const polygon = document.createElementNS(ns, "polygon");
        polygon.setAttribute("points", source.points
          .map(point => `${Number(point[0]) * width},${Number(point[1]) * height}`)
          .join(" "));
        polygon.setAttribute("fill", fill);
        parent.appendChild(polygon);
        return;
      }
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", String((Number(source.x) || 0) * width));
      circle.setAttribute("cy", String((Number(source.y) || 0) * height));
      circle.setAttribute("r", String(Math.max(1, width * gridFraction * ((Number(source.radius_feet) || 60) / 5))));
      circle.setAttribute("fill", fill);
      parent.appendChild(circle);
    };

    const darknessMask = document.createElementNS(ns, "mask");
    darknessMask.setAttribute("id", maskId);
    darknessMask.setAttribute("maskUnits", "userSpaceOnUse");
    darknessMask.setAttribute("x", "0");
    darknessMask.setAttribute("y", "0");
    darknessMask.setAttribute("width", String(width));
    darknessMask.setAttribute("height", String(height));
    const darknessBase = document.createElementNS(ns, "rect");
    darknessBase.setAttribute("x", "0");
    darknessBase.setAttribute("y", "0");
    darknessBase.setAttribute("width", String(width));
    darknessBase.setAttribute("height", String(height));
    darknessBase.setAttribute("fill", "white");
    darknessMask.appendChild(darknessBase);
    for (const source of sources) addVisionRegion(darknessMask, source, "black");
    defs.appendChild(darknessMask);

    if (nightSources.length) {
      const nightMask = document.createElementNS(ns, "mask");
      nightMask.setAttribute("id", nightMaskId);
      nightMask.setAttribute("maskUnits", "userSpaceOnUse");
      nightMask.setAttribute("x", "0");
      nightMask.setAttribute("y", "0");
      nightMask.setAttribute("width", String(width));
      nightMask.setAttribute("height", String(height));
      const nightBase = document.createElementNS(ns, "rect");
      nightBase.setAttribute("x", "0");
      nightBase.setAttribute("y", "0");
      nightBase.setAttribute("width", String(width));
      nightBase.setAttribute("height", String(height));
      nightBase.setAttribute("fill", "black");
      nightMask.appendChild(nightBase);
      for (const source of nightSources) addVisionRegion(nightMask, source, "white");
      for (const source of lightSources) addVisionRegion(nightMask, source, "black");
      defs.appendChild(nightMask);
    }

    previewDarknessLayer.appendChild(defs);

    if (nightSources.length && previewImage.currentSrc) {
      const nightImage = document.createElementNS(ns, "image");
      nightImage.setAttribute("href", previewImage.currentSrc);
      nightImage.setAttribute("x", "0");
      nightImage.setAttribute("y", "0");
      nightImage.setAttribute("width", String(width));
      nightImage.setAttribute("height", String(height));
      nightImage.setAttribute("preserveAspectRatio", "none");
      nightImage.setAttribute("filter", `url(#${grayFilterId})`);
      nightImage.setAttribute("mask", `url(#${nightMaskId})`);
      previewDarknessLayer.appendChild(nightImage);
    }

    const cover = document.createElementNS(ns, "rect");
    cover.setAttribute("x", "0");
    cover.setAttribute("y", "0");
    cover.setAttribute("width", String(width));
    cover.setAttribute("height", String(height));
    cover.setAttribute("fill", "#000000");
    cover.setAttribute("mask", `url(#${maskId})`);
    previewDarknessLayer.appendChild(cover);
    previewDarknessLayer.hidden = false;
  }

  function renderPreviewGrid() {
    if (!state || !state.grid_enabled || !previewContent.clientWidth) {
      previewGridLayer.hidden = true;
      return;
    }
    const gridPixels = Math.max(4, previewContent.clientWidth * (Number(state.grid_size) || 0.05));
    previewGridLayer.style.setProperty("--grid-cell", `${gridPixels}px`);
    previewGridLayer.style.setProperty("--grid-color", state.grid_color || "#ffffff");
    previewGridLayer.style.opacity = String(Math.max(0.10, Math.min(1, Number(state.grid_opacity) || 1)));
    previewGridLayer.hidden = false;
  }

  function positionFromPointer(event) {
    const rect = previewContent.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function beginAreaDrag(event, area, element, captureTarget = element) {
    event.preventDefault();
    event.stopPropagation();
    drag = { pointerId: event.pointerId, area, element, captureTarget, kind: "area" };
    captureTarget.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
  }

  function moveAreaDrag(event) {
    if (!drag || drag.kind !== "area" || drag.pointerId !== event.pointerId) return;
    const position = positionFromPointer(event);
    if (!position) return;
    drag.area.x = position.x;
    drag.area.y = position.y;
    drag.element.style.left = `${position.x * 100}%`;
    drag.element.style.top = `${position.y * 100}%`;
  }

  async function endAreaDrag(event) {
    if (!drag || drag.kind !== "area" || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.element.classList.remove("dragging");
    try {
      await api(`/api/areas/${encodeURIComponent(current.area.id)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: current.area.x, y: current.area.y }),
      });
    } catch (error) {
      showStatus(error.message, "error");
      await load();
    }
  }

  function beginConeRotate(event, area, element, handle) {
    event.preventDefault();
    event.stopPropagation();
    drag = { pointerId: event.pointerId, area, element, handle, kind: "cone-rotate" };
    handle.setPointerCapture(event.pointerId);
    element.classList.add("rotating");
  }

  function moveConeRotate(event) {
    if (!drag || drag.kind !== "cone-rotate" || drag.pointerId !== event.pointerId) return;
    const rect = previewContent.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const originX = rect.left + drag.area.x * rect.width;
    const originY = rect.top + drag.area.y * rect.height;
    let degrees = Math.atan2(event.clientY - originY, event.clientX - originX) * 180 / Math.PI;
    if (degrees < 0) degrees += 360;
    drag.area.rotation = degrees;
    drag.element.style.transform = `translate(0, -50%) rotate(${degrees}deg)`;
  }

  async function endConeRotate(event) {
    if (!drag || drag.kind !== "cone-rotate" || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.element.classList.remove("rotating");
    syncAreaRotationControl(current.area);
    try {
      const autosaver = areaAutosavers.get(current.area.id);
      if (autosaver) await autosaver.flushNow();
      await api(`/api/areas/${encodeURIComponent(current.area.id)}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotation: current.area.rotation }),
      });
    } catch (error) {
      showStatus(error.message, "error");
      await load();
    }
  }

  function coneDimensions(area, contentWidth) {
    const gridFraction = Math.max(0.01, Number(state?.grid_size) || 0.05);
    const lengthPixels = Math.max(8, contentWidth * gridFraction * (Number(area.length_squares) || 6));
    const angle = Math.max(15, Math.min(120, Number(area.angle) || 60));
    const heightPixels = Math.max(8, 2 * lengthPixels * Math.tan((angle / 2) * Math.PI / 180));
    return { lengthPixels, heightPixels, angle };
  }

  function buildConeElement(area, contentWidth, admin = false) {
    const { lengthPixels, heightPixels, angle } = coneDimensions(area, contentWidth);
    const element = document.createElement("div");
    element.className = `map-area map-cone${admin ? " admin-area" : ""}`;
    element.style.left = `${area.x * 100}%`;
    element.style.top = `${area.y * 100}%`;
    element.style.width = `${lengthPixels}px`;
    element.style.height = `${heightPixels}px`;
    element.style.transform = `translate(0, -50%) rotate(${Number(area.rotation) || 0}deg)`;
    const areaColor = area.color || "#e53935";
    element.style.setProperty("--area-color", areaColor);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.classList.add("cone-shape");
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("points", "1,50 99,2 99,98");
    polygon.setAttribute("fill", `${areaColor}47`);
    polygon.setAttribute("stroke", areaColor);
    polygon.setAttribute("stroke-width", "2");
    polygon.setAttribute("vector-effect", "non-scaling-stroke");
    polygon.classList.add("cone-polygon");
    svg.appendChild(polygon);
    element.appendChild(svg);

    if (admin) {
      polygon.addEventListener("pointerdown", event => beginAreaDrag(event, area, element, polygon));
      polygon.addEventListener("pointermove", moveAreaDrag);
      polygon.addEventListener("pointerup", endAreaDrag);
      polygon.addEventListener("pointercancel", endAreaDrag);

      const origin = document.createElement("span");
      origin.className = "cone-origin-marker";
      origin.title = "Cone origin";
      element.appendChild(origin);

      const handle = document.createElement("span");
      handle.className = "cone-rotation-handle";
      handle.title = "Drag to aim cone";
      handle.setAttribute("role", "button");
      handle.setAttribute("aria-label", "Drag to aim cone");
      handle.addEventListener("pointerdown", event => beginConeRotate(event, area, element, handle));
      handle.addEventListener("pointermove", moveConeRotate);
      handle.addEventListener("pointerup", endConeRotate);
      handle.addEventListener("pointercancel", endConeRotate);
      element.appendChild(handle);
    }
    element.title = admin
      ? `${area.name || "Cone"} - ${Number(area.length_squares || 6)} squares, ${Number(angle.toFixed(0))}°, direction ${Number((Number(area.rotation) || 0).toFixed(0))}°`
      : "";
    return element;
  }

  function lineDimensions(area, contentWidth) {
    const gridFraction = Math.max(0.01, Number(state?.grid_size) || 0.05);
    const lengthPixels = Math.max(8, contentWidth * gridFraction * (Number(area.length_squares) || 6));
    const widthPixels = Math.max(4, contentWidth * gridFraction * (Number(area.width_squares) || 1));
    return { lengthPixels, widthPixels };
  }

  function buildLineElement(area, contentWidth, admin = false) {
    const { lengthPixels, widthPixels } = lineDimensions(area, contentWidth);
    const element = document.createElement("div");
    element.className = `map-area map-line${admin ? " admin-area" : ""}`;
    element.style.left = `${area.x * 100}%`;
    element.style.top = `${area.y * 100}%`;
    element.style.width = `${lengthPixels}px`;
    element.style.height = `${widthPixels}px`;
    element.style.transform = `translate(0, -50%) rotate(${Number(area.rotation) || 0}deg)`;
    const areaColor = area.color || "#e53935";
    element.style.setProperty("--area-color", areaColor);
    element.style.backgroundColor = `${areaColor}47`;

    const body = document.createElement("div");
    body.className = "line-shape";
    body.style.borderColor = areaColor;
    body.style.backgroundColor = `${areaColor}47`;
    element.appendChild(body);

    if (admin) {
      body.addEventListener("pointerdown", event => beginAreaDrag(event, area, element, body));
      body.addEventListener("pointermove", moveAreaDrag);
      body.addEventListener("pointerup", endAreaDrag);
      body.addEventListener("pointercancel", endAreaDrag);

      const origin = document.createElement("span");
      origin.className = "cone-origin-marker";
      origin.title = "Line origin";
      element.appendChild(origin);

      const handle = document.createElement("span");
      handle.className = "cone-rotation-handle";
      handle.title = "Drag to aim line";
      handle.setAttribute("role", "button");
      handle.setAttribute("aria-label", "Drag to aim line");
      handle.addEventListener("pointerdown", event => beginConeRotate(event, area, element, handle));
      handle.addEventListener("pointermove", moveConeRotate);
      handle.addEventListener("pointerup", endConeRotate);
      handle.addEventListener("pointercancel", endConeRotate);
      element.appendChild(handle);
    }
    element.title = admin
      ? `${area.name || "Line"} - ${Number((Number(area.length_squares) || 6).toFixed(1))} squares long, ${Number((Number(area.width_squares) || 1).toFixed(2))} squares wide, direction ${Number((Number(area.rotation) || 0).toFixed(0))}°`
      : "";
    return element;
  }

  function buildCircleElement(area, contentWidth, admin = false) {
    const diameterPixels = Math.max(4, contentWidth * (Number(area.diameter) || 0.20));
    const element = document.createElement("div");
    element.className = `map-area map-circle${admin ? " admin-area" : ""}`;
    element.style.left = `${area.x * 100}%`;
    element.style.top = `${area.y * 100}%`;
    element.style.width = `${diameterPixels}px`;
    element.style.height = `${diameterPixels}px`;
    const areaColor = area.color || "#e53935";
    element.style.setProperty("--area-color", areaColor);
    element.style.backgroundColor = `${areaColor}47`;
    if (admin) {
      element.title = `${area.name || "Circle"} - ${Number(((area.diameter || 0.20) * 100).toFixed(1))}% diameter`;
      element.addEventListener("pointerdown", event => beginAreaDrag(event, area, element));
      element.addEventListener("pointermove", moveAreaDrag);
      element.addEventListener("pointerup", endAreaDrag);
      element.addEventListener("pointercancel", endAreaDrag);
    }
    return element;
  }

  function renderPreviewAreas() {
    previewAreaLayer.replaceChildren();
    if (!state || !previewContent.clientWidth) return;
    for (const area of state.areas || []) {
      let element;
      if (area.shape === "cone") {
        element = buildConeElement(area, previewContent.clientWidth, true);
      } else if (area.shape === "line") {
        element = buildLineElement(area, previewContent.clientWidth, true);
      } else {
        element = buildCircleElement(area, previewContent.clientWidth, true);
      }
      if (area.visible === false) element.classList.add("area-hidden-admin");
      previewAreaLayer.appendChild(element);
    }
  }

  function beginTokenDrag(event, token, element) {
    event.preventDefault();
    drag = { pointerId: event.pointerId, token, element, kind: "token" };
    element.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
  }

  function moveTokenDrag(event) {
    if (!drag || drag.kind !== "token" || drag.pointerId !== event.pointerId) return;
    const position = positionFromPointer(event);
    if (!position) return;
    drag.token.x = position.x;
    drag.token.y = position.y;
    drag.element.style.left = `${position.x * 100}%`;
    drag.element.style.top = `${position.y * 100}%`;
    if (
      (drag.token.player_controlled && drag.token.vision_enabled)
      || (!drag.token.player_controlled && drag.token.moved_by_token_id && drag.token.share_vision_with_controller)
    ) renderPreviewDarkness();
  }

  async function endTokenDrag(event) {
    if (!drag || drag.kind !== "token" || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.element.classList.remove("dragging");
    try {
      await api(`/api/tokens/${encodeURIComponent(current.token.id)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: current.token.x, y: current.token.y }),
      });
    } catch (error) {
      showStatus(error.message, "error");
      await load();
    }
  }

  function addInitiativeNumber(element, token, tokenPixels) {
    if (token.initiative === null || token.initiative === undefined || token.initiative === "") return;
    const value = String(token.initiative);
    const initiative = document.createElement("span");
    initiative.className = "token-initiative";
    initiative.textContent = value;
    const hex = String(token.color || "#000000").replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    initiative.classList.add(brightness >= 155 ? "initiative-dark-text" : "initiative-light-text");
    const ratio = value.length >= 3 ? 0.32 : 0.42;
    initiative.style.fontSize = `${Math.max(7, Math.min(28, tokenPixels * ratio))}px`;
    element.appendChild(initiative);
  }

  function npcVisibleInGmDarkness(token, visionSources) {
    if (!state || token.player_controlled || !state.dark_environment || !gmPreviewDarknessVisible) return true;
    if (token.reveal_in_darkness) return true;
    if (!previewContent.clientWidth || !previewContent.clientHeight) return true;

    const aspect = previewContent.clientHeight / previewContent.clientWidth;
    const gridFraction = Math.max(0.01, Number(state.grid_size) || 0.05);
    for (const source of visionSources || []) {
      if (!source.player_source) continue;
      if (Array.isArray(source.points) && source.points.length >= 3) {
        if (pointInPolygon(Number(token.x), Number(token.y), source.points)) return true;
        continue;
      }
      const radius = gridFraction * ((Number(source.radius_feet) || 60) / 5);
      const dx = Number(token.x) - Number(source.x);
      const dy = (Number(token.y) - Number(source.y)) * aspect;
      if (dx * dx + dy * dy <= radius * radius) return true;
    }
    return false;
  }

  function renderPreviewTokens() {
    previewTokenLayer.replaceChildren();
    if (!state || !previewContent.clientWidth) return;
    const tokenPixels = Math.max(8, previewContent.clientWidth * (Number(state.token_size) || 0.04));
    const gmVisionSources = state.dark_environment && gmPreviewDarknessVisible ? editorVisionSources() : [];
    for (const token of state.tokens || []) {
      if (!npcVisibleInGmDarkness(token, gmVisionSources)) continue;
      const element = document.createElement("div");
      element.className = "map-token draggable-token admin-token";
      if (token.visible === false) element.classList.add("token-hidden-admin");
      element.style.left = `${token.x * 100}%`;
      element.style.top = `${token.y * 100}%`;
      element.style.width = `${tokenPixels}px`;
      element.style.height = `${tokenPixels}px`;
      element.style.backgroundColor = token.color;
      element.setAttribute("aria-label", token.initiative === null || token.initiative === undefined
        ? token.name
        : `${token.name}, initiative ${token.initiative}`);
      addInitiativeNumber(element, token, tokenPixels);

      const label = document.createElement("span");
      label.className = "token-label";
      label.textContent = token.name;
      element.appendChild(label);

      element.addEventListener("pointerdown", event => beginTokenDrag(event, token, element));
      element.addEventListener("pointermove", moveTokenDrag);
      element.addEventListener("pointerup", endTokenDrag);
      element.addEventListener("pointercancel", endTokenDrag);
      previewTokenLayer.appendChild(element);
    }
  }

  function syncAreaRotationControl(area) {
    const card = [...areaList.querySelectorAll(".area-card")].find(item => item.dataset.areaId === area.id);
    if (!card) return;
    const role = area.shape === "line" ? "line" : "cone";
    const input = card.querySelector(`input[data-area-rotation="${role}"]`);
    if (input) input.value = String(Math.round(Number(area.rotation) || 0));
  }

  function areaCard(area) {
    const card = document.createElement("article");
    card.className = "area-card";
    card.dataset.areaId = area.id;

    const nameWrap = document.createElement("div");
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 60;
    nameInput.value = area.name || "Area";
    nameWrap.append(nameLabel, nameInput);

    const shapeWrap = document.createElement("div");
    const shapeLabel = document.createElement("label");
    shapeLabel.textContent = "Shape";
    const shapeSelect = document.createElement("select");
    for (const [value, label] of [["circle", "Circle"], ["cone", "Cone"], ["line", "Line"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      shapeSelect.appendChild(option);
    }
    shapeSelect.value = ["circle", "cone", "line"].includes(area.shape) ? area.shape : "circle";
    shapeWrap.append(shapeLabel, shapeSelect);

    const colorWrap = document.createElement("div");
    const colorLabel = document.createElement("label");
    colorLabel.textContent = "Color";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = area.color || "#e53935";
    colorWrap.append(colorLabel, colorInput);

    const settingsWrap = document.createElement("div");
    settingsWrap.className = "area-card-settings";

    const circleSettings = document.createElement("div");
    circleSettings.className = "area-inline-settings";
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = "Diameter";
    const sizeRow = document.createElement("div");
    sizeRow.className = "area-diameter-row";
    const sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "1";
    sizeInput.max = "200";
    sizeInput.step = "1";
    sizeInput.value = String(Math.round((Number(area.diameter) || 0.20) * 100));
    const sizeValue = document.createElement("output");
    sizeValue.textContent = `${sizeInput.value}%`;
    sizeRow.append(sizeInput, sizeValue);
    circleSettings.append(sizeLabel, sizeRow);

    const coneSettings = document.createElement("div");
    coneSettings.className = "area-inline-settings cone-inline-settings";
    const fields = [
      ["Length", "length_squares", 0.5, 60, 0.5, Number(area.length_squares) || 6, "sq"],
      ["Angle", "angle", 15, 120, 1, Number(area.angle) || 60, "°"],
      ["Direction", "rotation", 0, 359, 1, Number(area.rotation) || 0, "°"],
    ];
    const coneInputs = {};
    for (const [labelText, key, min, max, step, value, suffix] of fields) {
      const field = document.createElement("div");
      field.className = "area-mini-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      const row = document.createElement("div");
      row.className = "area-size-input";
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(Number(value.toFixed ? value.toFixed(key === "length_squares" ? 1 : 0) : value));
      if (key === "rotation") input.dataset.areaRotation = "cone";
      const unit = document.createElement("span");
      unit.textContent = suffix;
      row.append(input, unit);
      field.append(label, row);
      coneSettings.appendChild(field);
      coneInputs[key] = input;
    }

    const lineSettings = document.createElement("div");
    lineSettings.className = "area-inline-settings cone-inline-settings";
    const lineFields = [
      ["Length", "length_squares", 0.5, 60, 0.5, Number(area.length_squares) || 6, "sq"],
      ["Width", "width_squares", 0.25, 20, 0.25, Number(area.width_squares) || 1, "sq"],
      ["Direction", "rotation", 0, 359, 1, Number(area.rotation) || 0, "°"],
    ];
    const lineInputs = {};
    for (const [labelText, key, min, max, step, value, suffix] of lineFields) {
      const field = document.createElement("div");
      field.className = "area-mini-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      const row = document.createElement("div");
      row.className = "area-size-input";
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(Number(value.toFixed ? value.toFixed(key === "length_squares" || key === "width_squares" ? 2 : 0) : value));
      if (key === "rotation") input.dataset.areaRotation = "line";
      const unit = document.createElement("span");
      unit.textContent = suffix;
      row.append(input, unit);
      field.append(label, row);
      lineSettings.appendChild(field);
      lineInputs[key] = input;
    }
    settingsWrap.append(circleSettings, coneSettings, lineSettings);

    const actions = document.createElement("div");
    actions.className = "area-card-actions";
    const visibleLabel = document.createElement("label");
    visibleLabel.className = "switch-row area-visible-control";
    const visibleInput = document.createElement("input");
    visibleInput.type = "checkbox";
    visibleInput.checked = area.visible !== false;
    const visibleText = document.createElement("span");
    visibleText.textContent = "Visible";
    visibleLabel.append(visibleInput, visibleText);

    const saveStatus = document.createElement("span");
    saveStatus.className = "autosave-status";
    saveStatus.setAttribute("aria-live", "polite");
    saveStatus.textContent = "Saved";
    saveStatus.dataset.state = "saved";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "Delete";
    actions.append(visibleLabel, saveStatus, remove);

    function updateShapeControls() {
      const isCone = shapeSelect.value === "cone";
      const isLine = shapeSelect.value === "line";
      circleSettings.hidden = isCone || isLine;
      coneSettings.hidden = !isCone;
      lineSettings.hidden = !isLine;
    }

    function previewEdits() {
      area.name = nameInput.value.trim() || "Area";
      area.shape = shapeSelect.value;
      area.color = colorInput.value;
      area.visible = visibleInput.checked;
      area.diameter = Number(sizeInput.value) / 100;
      area.length_squares = Number(coneInputs.length_squares.value) || 6;
      area.width_squares = Number(lineInputs.width_squares.value) || 1;
      area.angle = Number(coneInputs.angle.value) || 60;
      area.rotation = shapeSelect.value === "line"
        ? ((Number(lineInputs.rotation.value) || 0) % 360 + 360) % 360
        : ((Number(coneInputs.rotation.value) || 0) % 360 + 360) % 360;
      if (shapeSelect.value === "line") {
        area.length_squares = Number(lineInputs.length_squares.value) || 6;
      }
      sizeValue.textContent = `${sizeInput.value}%`;
      updateShapeControls();
      renderPreviewAreas();
    }

    const autosaver = createCardAutosaver(
      saveStatus,
      () => api(`/api/areas/${encodeURIComponent(area.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value,
          shape: shapeSelect.value,
          color: colorInput.value,
          diameter: Number(sizeInput.value) / 100,
          length_squares: shapeSelect.value === "line" ? Number(lineInputs.length_squares.value) : Number(coneInputs.length_squares.value),
          width_squares: Number(lineInputs.width_squares.value),
          angle: Number(coneInputs.angle.value),
          rotation: shapeSelect.value === "line" ? Number(lineInputs.rotation.value) : Number(coneInputs.rotation.value),
          visible: visibleInput.checked,
        }),
      }),
      result => {
        if (result?.area) Object.assign(area, result.area);
        renderPreviewAreas();
      },
    );
    areaAutosavers.set(area.id, autosaver);

    nameInput.addEventListener("input", () => {
      previewEdits();
      autosaver.schedule(650);
    });
    nameInput.addEventListener("blur", () => autosaver.schedule(0));
    shapeSelect.addEventListener("change", () => {
      previewEdits();
      autosaver.schedule(0);
    });
    colorInput.addEventListener("input", () => {
      previewEdits();
      autosaver.schedule(200);
    });
    colorInput.addEventListener("change", () => autosaver.schedule(0));
    visibleInput.addEventListener("change", () => {
      previewEdits();
      autosaver.schedule(0);
    });
    sizeInput.addEventListener("input", () => {
      previewEdits();
      autosaver.schedule(250);
    });
    sizeInput.addEventListener("change", () => autosaver.schedule(0));
    for (const input of Object.values(coneInputs)) {
      input.addEventListener("input", () => {
        previewEdits();
        autosaver.schedule(500);
      });
      input.addEventListener("change", () => autosaver.schedule(0));
    }
    for (const input of Object.values(lineInputs)) {
      input.addEventListener("input", () => {
        previewEdits();
        autosaver.schedule(500);
      });
      input.addEventListener("change", () => autosaver.schedule(0));
    }
    updateShapeControls();

    remove.addEventListener("click", async () => {
      if (!confirm(`Delete ${shapeSelect.value} AOE “${area.name || "Area"}”?`)) return;
      autosaver.cancel();
      await autosaver.waitForIdle();
      try {
        await api(`/api/areas/${encodeURIComponent(area.id)}`, { method: "DELETE" });
        areaAutosavers.delete(area.id);
        await load();
        showStatus("AOE overlay deleted.");
      } catch (error) {
        showStatus(error.message, "error");
      }
    });

    card.append(nameWrap, shapeWrap, colorWrap, settingsWrap, actions);
    return card;
  }
  function renderAreaList() {
    for (const controller of areaAutosavers.values()) controller.cancel();
    areaAutosavers.clear();
    areaList.replaceChildren();
    if (!state?.areas?.length) {
      const empty = document.createElement("p");
      empty.className = "help-text";
      empty.textContent = "No AOE overlays yet.";
      areaList.appendChild(empty);
      return;
    }
    for (const area of state.areas) areaList.appendChild(areaCard(area));
  }

  const TOKEN_CATEGORY_ORDER = ["players", "player-npcs", "gm-npcs"];
  const TOKEN_CATEGORY_META = {
    "players": { title: "Players", className: "token-category-players" },
    "player-npcs": { title: "Player-controlled NPCs", className: "token-category-player-npcs" },
    "gm-npcs": { title: "GM-controlled NPCs", className: "token-category-gm-npcs" },
  };

  function tokenCategoryKey(token) {
    if (token.player_controlled) return "players";
    return token.moved_by_token_id ? "player-npcs" : "gm-npcs";
  }

  function updateTokenCardCategoryClass(card, token) {
    card.classList.remove("token-card-player", "token-card-player-npc", "token-card-gm-npc");
    const category = tokenCategoryKey(token);
    card.classList.add(category === "players"
      ? "token-card-player"
      : category === "player-npcs" ? "token-card-player-npc" : "token-card-gm-npc");
  }

  function ensureTokenCategorySection(category) {
    let section = tokenList.querySelector(`.token-category[data-token-category="${category}"]`);
    if (section) return section;

    const meta = TOKEN_CATEGORY_META[category];
    section = document.createElement("section");
    section.className = `token-category ${meta.className}`;
    section.dataset.tokenCategory = category;

    const heading = document.createElement("h3");
    heading.className = "token-category-title";
    heading.textContent = meta.title;
    const cards = document.createElement("div");
    cards.className = "token-category-list";
    section.append(heading, cards);

    const categoryIndex = TOKEN_CATEGORY_ORDER.indexOf(category);
    const laterSection = [...tokenList.querySelectorAll(".token-category")].find(item =>
      TOKEN_CATEGORY_ORDER.indexOf(item.dataset.tokenCategory) > categoryIndex);
    if (laterSection) tokenList.insertBefore(section, laterSection);
    else tokenList.appendChild(section);
    return section;
  }

  function repositionTokenCard(card, token) {
    updateTokenCardCategoryClass(card, token);
    const oldSection = card.closest(".token-category");
    const targetSection = ensureTokenCategorySection(tokenCategoryKey(token));
    const targetList = targetSection.querySelector(".token-category-list");
    targetList.appendChild(card);

    const cards = [...targetList.querySelectorAll(":scope > .token-card")];
    cards.sort((a, b) => {
      const tokenA = (state?.tokens || []).find(item => item.id === a.dataset.tokenId);
      const tokenB = (state?.tokens || []).find(item => item.id === b.dataset.tokenId);
      return String(tokenA?.name || "").localeCompare(String(tokenB?.name || ""), undefined, { sensitivity: "base" });
    });
    for (const item of cards) targetList.appendChild(item);

    if (oldSection && oldSection !== targetSection && !oldSection.querySelector(".token-card")) oldSection.remove();
  }

  function refreshDelegateSelects() {
    populateDelegateSelect(newMovedByTokenId, newMovedByTokenId?.value || "");
    for (const select of tokenList.querySelectorAll("select.token-delegate-select")) {
      const card = select.closest(".token-card");
      populateDelegateSelect(select, select.value || "", card?.dataset.tokenId || null);
    }
  }

  function tokenCard(token) {
    const card = document.createElement("article");
    card.className = "token-card";
    updateTokenCardCategoryClass(card, token);
    card.dataset.tokenId = token.id;

    const grid = document.createElement("div");
    grid.className = "form-grid token-form-grid";

    const nameWrap = document.createElement("div");
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 60;
    nameInput.className = "token-name-input";
    nameInput.value = token.name;

    const controlWrap = document.createElement("div");
    controlWrap.className = "token-control-option token-player-control-inline";
    const controlLabel = document.createElement("label");
    controlLabel.className = "switch-row";
    const controlled = document.createElement("input");
    controlled.type = "checkbox";
    controlled.checked = Boolean(token.player_controlled);
    const controlText = document.createElement("span");
    controlText.textContent = "Player character";
    controlLabel.append(controlled, controlText);
    controlWrap.append(controlLabel);

    const nameControlRow = document.createElement("div");
    nameControlRow.className = "token-name-control-row";
    nameControlRow.append(nameInput, controlWrap);
    nameWrap.append(nameLabel, nameControlRow);

    const colorWrap = document.createElement("div");
    const colorLabel = document.createElement("label");
    colorLabel.textContent = "Color";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = token.color;
    colorWrap.append(colorLabel, colorInput);
    grid.append(nameWrap, colorWrap);
    card.append(grid);

    const optionsGrid = document.createElement("div");
    optionsGrid.className = "token-options-grid";

    const initiativeWrap = document.createElement("div");
    const initiativeLabel = document.createElement("label");
    initiativeLabel.textContent = "Initiative";
    const initiativeInput = document.createElement("input");
    initiativeInput.type = "number";
    initiativeInput.min = "-99";
    initiativeInput.max = "99";
    initiativeInput.step = "1";
    initiativeInput.inputMode = "numeric";
    initiativeInput.className = "initiative-input";
    initiativeInput.placeholder = "17";
    initiativeInput.value = token.initiative === null || token.initiative === undefined ? "" : token.initiative;
    initiativeWrap.append(initiativeLabel, initiativeInput);

    const visibleWrap = document.createElement("div");
    visibleWrap.className = "token-control-option";
    const visibleLabel = document.createElement("label");
    visibleLabel.className = "switch-row";
    const visibleInput = document.createElement("input");
    visibleInput.type = "checkbox";
    visibleInput.checked = token.visible !== false;
    const visibleText = document.createElement("span");
    visibleText.textContent = "Visible";
    visibleLabel.append(visibleInput, visibleText);
    visibleWrap.append(visibleLabel);

    optionsGrid.append(initiativeWrap, visibleWrap);
    card.append(optionsGrid);

    const visionWrap = document.createElement("div");
    visionWrap.className = "vision-control-row";
    const visionOption = document.createElement("div");
    visionOption.className = "token-control-option";
    const visionLabel = document.createElement("label");
    visionLabel.className = "switch-row";
    const visionEnabledInput = document.createElement("input");
    visionEnabledInput.type = "checkbox";
    visionEnabledInput.checked = Boolean(token.vision_enabled);
    const visionText = document.createElement("span");
    visionText.textContent = "Vision in darkness";
    visionLabel.append(visionEnabledInput, visionText);
    visionOption.append(visionLabel);

    const nightVisionOption = document.createElement("div");
    nightVisionOption.className = "token-control-option";
    const nightVisionLabel = document.createElement("label");
    nightVisionLabel.className = "switch-row";
    const nightVisionInput = document.createElement("input");
    nightVisionInput.type = "checkbox";
    nightVisionInput.checked = token.vision_type === "nightvision";
    const nightVisionText = document.createElement("span");
    nightVisionText.textContent = "Nightvision (grayscale)";
    nightVisionLabel.append(nightVisionInput, nightVisionText);
    nightVisionOption.append(nightVisionLabel);

    const visionRadiusWrap = document.createElement("div");
    visionRadiusWrap.className = "vision-radius-wrap";
    const visionRadiusLabel = document.createElement("label");
    visionRadiusLabel.textContent = "Vision radius (feet)";
    const visionRadiusInput = document.createElement("input");
    visionRadiusInput.type = "number";
    visionRadiusInput.min = "1";
    visionRadiusInput.max = "300";
    visionRadiusInput.step = "0.5";
    visionRadiusInput.inputMode = "decimal";
    visionRadiusInput.className = "vision-radius-input";
    visionRadiusInput.value = Number(token.vision_radius_feet || 60);
    visionRadiusWrap.append(visionRadiusLabel, visionRadiusInput);
    visionWrap.append(visionOption, nightVisionOption, visionRadiusWrap);

    const delegateWrap = document.createElement("div");
    delegateWrap.className = "delegate-control-row token-delegate-row";
    const delegateInner = document.createElement("div");
    const delegateLabel = document.createElement("label");
    delegateLabel.textContent = "Moved by player";
    const delegateSelect = document.createElement("select");
    delegateSelect.className = "token-delegate-select";
    populateDelegateSelect(delegateSelect, token.moved_by_token_id || "", token.id);
    delegateInner.append(delegateLabel, delegateSelect);

    const npcOptionsWrap = document.createElement("div");
    npcOptionsWrap.className = "npc-delegate-options";

    const npcShareVisionOption = document.createElement("div");
    npcShareVisionOption.className = "token-control-option npc-share-vision-option";
    const npcShareVisionLabel = document.createElement("label");
    npcShareVisionLabel.className = "switch-row";
    const npcShareVisionInput = document.createElement("input");
    npcShareVisionInput.type = "checkbox";
    npcShareVisionInput.checked = Boolean(token.share_vision_with_controller);
    const npcShareVisionText = document.createElement("span");
    npcShareVisionText.textContent = "Share vision with controlling player";
    npcShareVisionLabel.append(npcShareVisionInput, npcShareVisionText);
    npcShareVisionOption.append(npcShareVisionLabel);

    const npcRevealOption = document.createElement("div");
    npcRevealOption.className = "token-control-option npc-reveal-option";
    const npcRevealLabel = document.createElement("label");
    npcRevealLabel.className = "switch-row";
    const npcRevealInput = document.createElement("input");
    npcRevealInput.type = "checkbox";
    npcRevealInput.checked = Boolean(token.reveal_in_darkness);
    const npcRevealText = document.createElement("span");
    npcRevealText.textContent = "Reveal in darkness (1 ft)";
    npcRevealLabel.append(npcRevealInput, npcRevealText);
    npcRevealOption.append(npcRevealLabel);
    npcOptionsWrap.append(npcShareVisionOption, npcRevealOption);
    delegateWrap.append(delegateInner, npcOptionsWrap);
    card.append(delegateWrap, visionWrap);

    function updateTokenModeControls() {
      const isPlayerControlled = controlled.checked;
      delegateSelect.disabled = isPlayerControlled;
      delegateWrap.hidden = isPlayerControlled;
      npcRevealInput.disabled = isPlayerControlled;
      if (isPlayerControlled) {
        delegateSelect.value = "";
        npcShareVisionInput.checked = false;
      } else {
        populateDelegateSelect(delegateSelect, delegateSelect.value || token.moved_by_token_id || "", token.id);
      }

      const hasController = !isPlayerControlled && Boolean(delegateSelect.value);
      if (!hasController) npcShareVisionInput.checked = false;
      npcShareVisionOption.hidden = !hasController;
      npcShareVisionInput.disabled = !hasController;

      visionOption.hidden = !isPlayerControlled;
      const sharedNpcVision = hasController && npcShareVisionInput.checked;
      visionWrap.hidden = !(isPlayerControlled || sharedNpcVision);
      visionEnabledInput.disabled = !isPlayerControlled;
      const visionActive = isPlayerControlled ? visionEnabledInput.checked : sharedNpcVision;
      nightVisionInput.disabled = !visionActive;
      visionRadiusInput.disabled = !visionActive;
    }

    function syncTokenFromControls() {
      const editedName = nameInput.value.trim();
      if (editedName) token.name = editedName;
      token.color = colorInput.value;
      token.initiative = initiativeInput.value === "" ? null : Number(initiativeInput.value);
      token.visible = visibleInput.checked;
      token.player_controlled = controlled.checked;
      token.moved_by_token_id = controlled.checked ? null : (delegateSelect.value || null);
      token.vision_enabled = controlled.checked ? visionEnabledInput.checked : false;
      token.vision_radius_feet = Number(visionRadiusInput.value) || 60;
      token.vision_type = nightVisionInput.checked ? "nightvision" : "light";
      token.share_vision_with_controller = !controlled.checked
        && Boolean(delegateSelect.value)
        && npcShareVisionInput.checked;
      token.reveal_in_darkness = controlled.checked ? false : npcRevealInput.checked;
    }

    function refreshTokenPreview() {
      renderPreviewDarkness();
      renderPreviewTokens();
      renderInitiativeList();
    }

    const actions = document.createElement("div");
    actions.className = "button-row token-actions";
    const saveStatus = document.createElement("span");
    saveStatus.className = "autosave-status";
    saveStatus.setAttribute("aria-live", "polite");
    saveStatus.textContent = "Saved";
    saveStatus.dataset.state = "saved";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "Delete";
    actions.append(saveStatus, remove);
    card.append(actions);

    let placementAfterSave = false;
    let delegatesAfterSave = false;
    const autosaver = createCardAutosaver(
      saveStatus,
      () => api(`/api/tokens/${encodeURIComponent(token.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value,
          color: colorInput.value,
          initiative: initiativeInput.value,
          visible: visibleInput.checked,
          player_controlled: controlled.checked,
          vision_enabled: visionEnabledInput.checked,
          vision_radius_feet: Number(visionRadiusInput.value),
          vision_type: nightVisionInput.checked ? "nightvision" : "light",
          share_vision_with_controller: !controlled.checked
            && Boolean(delegateSelect.value)
            && npcShareVisionInput.checked,
          reveal_in_darkness: controlled.checked ? false : npcRevealInput.checked,
          moved_by_token_id: delegateSelect.value,
        }),
      }),
      result => {
        if (result?.token) {
          Object.assign(token, result.token);
        }
        updateTokenCardCategoryClass(card, token);
        if (placementAfterSave) repositionTokenCard(card, token);
        if (delegatesAfterSave) refreshDelegateSelects();
        placementAfterSave = false;
        delegatesAfterSave = false;
        refreshTokenPreview();
      },
    );
    tokenAutosavers.set(token.id, autosaver);

    nameInput.addEventListener("input", () => {
      syncTokenFromControls();
      renderPreviewTokens();
      renderInitiativeList();
      autosaver.schedule(650);
    });
    nameInput.addEventListener("blur", () => {
      placementAfterSave = true;
      delegatesAfterSave = true;
      autosaver.schedule(0);
    });
    colorInput.addEventListener("input", () => {
      syncTokenFromControls();
      renderPreviewTokens();
      renderInitiativeList();
      autosaver.schedule(200);
    });
    colorInput.addEventListener("change", () => autosaver.schedule(0));
    initiativeInput.addEventListener("input", () => {
      syncTokenFromControls();
      renderPreviewTokens();
      renderInitiativeList();
      autosaver.schedule(500);
    });
    initiativeInput.addEventListener("change", () => autosaver.schedule(0));
    visibleInput.addEventListener("change", () => {
      syncTokenFromControls();
      syncMasterTokenVisibilityControl();
      refreshTokenPreview();
      autosaver.schedule(0);
    });
    controlled.addEventListener("change", () => {
      if (controlled.checked && (delegateSelect.value || token.moved_by_token_id)) {
        const controllerName = delegateSelect.options[delegateSelect.selectedIndex]?.textContent || "its player";
        const confirmed = confirm(
          `Convert ${token.name} to a player character? This will remove the Moved by player assignment (${controllerName}).`
        );
        if (!confirmed) {
          controlled.checked = false;
          return;
        }
      }
      updateTokenModeControls();
      syncTokenFromControls();
      updateTokenCardCategoryClass(card, token);
      placementAfterSave = true;
      delegatesAfterSave = true;
      refreshTokenPreview();
      autosaver.schedule(0);
    });
    visionEnabledInput.addEventListener("change", () => {
      updateTokenModeControls();
      syncTokenFromControls();
      refreshTokenPreview();
      autosaver.schedule(0);
    });
    nightVisionInput.addEventListener("change", () => {
      syncTokenFromControls();
      renderPreviewDarkness();
      autosaver.schedule(0);
    });
    visionRadiusInput.addEventListener("input", () => {
      syncTokenFromControls();
      renderPreviewDarkness();
      autosaver.schedule(500);
    });
    visionRadiusInput.addEventListener("change", () => autosaver.schedule(0));
    delegateSelect.addEventListener("change", () => {
      syncTokenFromControls();
      updateTokenModeControls();
      updateTokenCardCategoryClass(card, token);
      placementAfterSave = true;
      refreshTokenPreview();
      autosaver.schedule(0);
    });
    npcShareVisionInput.addEventListener("change", () => {
      updateTokenModeControls();
      syncTokenFromControls();
      refreshTokenPreview();
      autosaver.schedule(0);
    });
    npcRevealInput.addEventListener("change", () => {
      syncTokenFromControls();
      refreshTokenPreview();
      autosaver.schedule(0);
    });
    updateTokenModeControls();

    remove.addEventListener("click", async () => {
      if (!confirm(`Delete token “${token.name}”?`)) return;
      autosaver.cancel();
      await autosaver.waitForIdle();
      try {
        await api(`/api/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
        tokenAutosavers.delete(token.id);
        await load();
        showStatus("Token deleted.");
      } catch (error) {
        showStatus(error.message, "error");
      }
    });

    return card;
  }
  function renderTokenList() {
    for (const controller of tokenAutosavers.values()) controller.cancel();
    tokenAutosavers.clear();
    tokenList.replaceChildren();
    populateDelegateSelect(newMovedByTokenId, newMovedByTokenId?.value || "");
    if (!state.tokens || !state.tokens.length) {
      const empty = document.createElement("p");
      empty.className = "help-text";
      empty.textContent = "No tokens yet.";
      tokenList.appendChild(empty);
      return;
    }
    const alphaSort = (a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });

    const groups = [
      ["players", state.tokens.filter(token => token.player_controlled).sort(alphaSort)],
      ["player-npcs", state.tokens.filter(token => !token.player_controlled && token.moved_by_token_id).sort(alphaSort)],
      ["gm-npcs", state.tokens.filter(token => !token.player_controlled && !token.moved_by_token_id).sort(alphaSort)],
    ];

    for (const [category, tokens] of groups) {
      if (!tokens.length) continue;
      const section = ensureTokenCategorySection(category);
      const cards = section.querySelector(".token-category-list");
      for (const token of tokens) cards.appendChild(tokenCard(token));
    }
  }

  function formatActivityTime(timestamp) {
    if (!timestamp) return "";
    const stamp = new Date(timestamp);
    if (Number.isNaN(stamp.getTime())) return timestamp;
    return stamp.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function renderActivityLog(container, entries, descriptionFor, emptyText) {
    if (!container) return;
    container.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "help-text";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "player-activity-row";

      const time = document.createElement("time");
      time.textContent = formatActivityTime(entry.timestamp);
      if (entry.timestamp) time.dateTime = entry.timestamp;

      const description = document.createElement("span");
      description.textContent = descriptionFor(entry);

      const ip = document.createElement("code");
      ip.textContent = entry.ip || "unknown";

      row.append(time, description, ip);
      container.appendChild(row);
    }
  }

  function renderPlayerActivity() {
    renderActivityLog(
      playerConnectionLog,
      Array.isArray(state?.player_connections) ? state.player_connections : [],
      entry => entry.player || "Player",
      "No player connections logged yet.",
    );
    renderActivityLog(
      playerMoveLog,
      Array.isArray(state?.player_moves) ? state.player_moves : [],
      entry => `${entry.moved_by || "Player"} moved ${entry.token_name || "token"}`,
      "No player moves logged yet.",
    );
  }

  function hasInitiative(token) {
    return token && token.initiative !== null && token.initiative !== undefined && token.initiative !== "";
  }

  function compareInitiativeTokens(a, b) {
    const aHas = hasInitiative(a);
    const bHas = hasInitiative(b);
    if (aHas && bHas) {
      const delta = Number(b.initiative) - Number(a.initiative);
      if (delta) return delta;
    } else if (aHas !== bHas) {
      return aHas ? -1 : 1;
    }
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
  }

  function renderInitiativeList() {
    initiativeList.replaceChildren();
    if (!state?.tokens?.length) {
      initiativeEnforced.checked = false;
      initiativeEnforced.disabled = true;
      initiativePreviousButton.disabled = true;
      initiativeNextButton.disabled = true;
      activeInitiativeLabel.textContent = "Active: -";
      const empty = document.createElement("p");
      empty.className = "help-text";
      empty.textContent = "No tokens yet.";
      initiativeList.appendChild(empty);
      return;
    }

    const orderedTokens = [...state.tokens].sort(compareInitiativeTokens);
    const activeToken = orderedTokens.find(token => token.id === state.active_initiative_token_id && hasInitiative(token));
    const hasTurnTokens = orderedTokens.some(hasInitiative);
    initiativeEnforced.checked = Boolean(state.initiative_enforced);
    initiativeEnforced.disabled = !hasTurnTokens;
    initiativePreviousButton.disabled = !hasTurnTokens;
    initiativeNextButton.disabled = !hasTurnTokens;
    activeInitiativeLabel.textContent = activeToken
      ? `Active: ${activeToken.name} (${activeToken.initiative})`
      : "Active: -";

    const splitAt = Math.ceil(orderedTokens.length / 2);
    const columns = [orderedTokens.slice(0, splitAt), orderedTokens.slice(splitAt)];

    for (const columnTokens of columns) {
      if (!columnTokens.length) continue;
      const column = document.createElement("div");
      column.className = "initiative-column";

      for (const token of columnTokens) {
        const row = document.createElement("div");
        row.className = "initiative-row";
        if (hasInitiative(token) && token.id === state.active_initiative_token_id) {
          row.classList.add("initiative-row-active");
          row.setAttribute("aria-current", "true");
        }

        const number = document.createElement("span");
        number.className = "initiative-badge";
        if (hasInitiative(token)) {
          number.textContent = token.initiative;
        } else {
          number.textContent = "-";
          number.classList.add("initiative-badge-empty");
        }

        const nameWrap = document.createElement("div");
        nameWrap.className = "initiative-name-wrap";

        const dot = document.createElement("span");
        dot.className = "token-color-dot initiative-token-dot";
        dot.style.backgroundColor = token.color || "#888888";

        const name = document.createElement("span");
        name.className = "initiative-token-name";
        name.textContent = token.name || "Unnamed token";

        nameWrap.append(dot, name);
        row.append(number, nameWrap);
        column.appendChild(row);
      }

      initiativeList.appendChild(column);
    }
  }

  function mapLibraryButton(label, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", handler);
    return button;
  }

  function syncMasterTokenVisibilityControl() {
    if (!tokensVisible || !state) return;
    const visibility = (state.tokens || []).map(token => token.visible !== false);
    tokensVisible.checked = visibility.every(Boolean);
    tokensVisible.indeterminate = visibility.some(Boolean) && !visibility.every(Boolean);
  }

  function renderMapLibrary() {
    if (!mapLibraryList || !state) return;
    mapLibraryList.replaceChildren();
    const maps = Array.isArray(state.maps) ? state.maps : [];
    const maxMaps = Number(state.max_maps) || 20;
    mapLibraryCount.textContent = `${maps.length} / ${maxMaps} maps`;

    for (const map of maps) {
      const row = document.createElement("div");
      row.className = `map-library-row${map.active ? " active-map" : ""}`;

      const info = document.createElement("div");
      info.className = "map-library-info";
      const titleRow = document.createElement("div");
      titleRow.className = "map-library-title-row";
      const name = document.createElement("strong");
      name.textContent = map.name || "Map";
      titleRow.appendChild(name);
      if (map.active) {
        const badge = document.createElement("span");
        badge.className = "map-active-badge";
        badge.textContent = "ACTIVE";
        titleRow.appendChild(badge);
      }
      const details = document.createElement("span");
      details.className = "help-text map-library-details";
      const file = map.original_filename || "Map image";
      details.textContent = `${file} · ${Number(map.wall_count) || 0} walls · ${Number(map.door_count) || 0} doors`;
      info.append(titleRow, details);

      const actions = document.createElement("div");
      actions.className = "map-library-actions";
      const prepare = document.createElement("a");
      prepare.className = "button-link";
      prepare.textContent = "Prepare walls";
      prepare.href = `/edit/wallmap?map=${encodeURIComponent(map.id)}`;
      prepare.target = "_blank";
      actions.appendChild(prepare);

      actions.appendChild(mapLibraryButton("Reset map", "", async () => {
        const warning = `Reset ${map.name}? This clears this map's sight/fog history and makes every token and AOE overlay invisible on this map. Walls, doors, the map image, and other prepared map settings will be kept.`;
        if (!window.confirm(warning)) return;
        try {
          await flushCardAutosaves();
          await api(`/edit/api/maps/${encodeURIComponent(map.id)}/reset`, { method: "POST" });
          await load();
          showStatus(`${map.name} reset. Tokens and AOE overlays are hidden, exploration is clear, and walls/doors were kept.`);
        } catch (error) {
          showStatus(error.message, "error");
        }
      }));

      if (!map.active) {
        actions.appendChild(mapLibraryButton("Activate", "primary-button", async () => {
          if (!window.confirm(`Activate ${map.name}? Connected players will immediately switch to this map.`)) return;
          try {
            await flushCardAutosaves();
            await api(`/edit/api/maps/${encodeURIComponent(map.id)}/activate`, { method: "POST" });
            await load();
            showStatus(`${map.name} is now the active map.`);
          } catch (error) {
            showStatus(error.message, "error");
          }
        }));
      }

      actions.appendChild(mapLibraryButton("Rename", "", async () => {
        const nextName = window.prompt("Map name:", map.name || "Map");
        if (nextName === null) return;
        const trimmed = nextName.trim();
        if (!trimmed) return showStatus("Enter a map name.", "error");
        try {
          await api(`/edit/api/maps/${encodeURIComponent(map.id)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: trimmed }),
          });
          await load();
          showStatus("Map renamed.");
        } catch (error) {
          showStatus(error.message, "error");
        }
      }));

      actions.appendChild(mapLibraryButton("Delete", "danger-button", async () => {
        const warning = map.active
          ? `Delete the ACTIVE map ${map.name}? The player/viewer display will immediately clear. Its image, walls, doors, grid settings, map-specific token/AOE visibility, and explored fog will be permanently removed.`
          : `Delete ${map.name}? Its image, walls, doors, grid settings, map-specific token/AOE visibility, and explored fog will be permanently removed.`;
        if (!window.confirm(warning)) return;
        try {
          await flushCardAutosaves();
          await api(`/edit/api/maps/${encodeURIComponent(map.id)}`, { method: "DELETE" });
          await load();
          showStatus(map.active
            ? `${map.name} deleted. There is no active map until you activate or add one.`
            : `${map.name} deleted.`);
        } catch (error) {
          showStatus(error.message, "error");
        }
      }));

      row.append(info, actions);
      mapLibraryList.appendChild(row);
    }
  }

  function apply(nextState) {
    state = nextState;
    const zoomPercent = Math.round((Number(state.zoom) || 1) * 100);
    zoomSlider.value = zoomPercent;
    zoomValue.textContent = `${zoomPercent}%`;
    background.value = state.background || "#000000";
    previewStage.style.background = background.value;
    gridEnabled.checked = Boolean(state.grid_enabled);
    const gridPercent = (Number(state.grid_size) || 0.05) * 100;
    gridSizeSlider.value = gridPercent;
    gridSizeValue.textContent = `${Number(gridPercent.toFixed(2))}%`;
    gridColor.value = state.grid_color || "#ffffff";
    const gridOpacityPercent = Math.round((Number(state.grid_opacity) || 1) * 100);
    gridOpacitySlider.value = gridOpacityPercent;
    gridOpacityValue.textContent = `${gridOpacityPercent}%`;
    const hasSelectedMap = Boolean(state.map_id);
    for (const control of [zoomSlider, zoomIn, zoomOut, fitButton, background, gridEnabled, gridSizeSlider, gridColor, gridOpacitySlider]) {
      if (control) control.disabled = !hasSelectedMap;
    }
    const tokenVisibility = (state.tokens || []).map(token => token.visible !== false);
    const allTokensVisible = tokenVisibility.every(Boolean);
    const someTokensVisible = tokenVisibility.some(Boolean);
    tokensVisible.checked = allTokensVisible;
    tokensVisible.indeterminate = someTokensVisible && !allTokensVisible;
    movementEnabled.checked = Boolean(state.movement_enabled);
    darkEnvironment.checked = Boolean(state.dark_environment);
    stackPlayerVision.checked = Boolean(state.stack_player_vision);
    persistentExploredFog.checked = Boolean(state.persistent_explored_fog);
    const sizePercent = (Number(state.token_size) || 0.04) * 100;
    tokenSizeSlider.value = sizePercent;
    tokenSizeValue.textContent = `${Number(sizePercent.toFixed(1))}%`;
    const mobileSizePercent = (Number(state.mobile_token_size) || Number(state.token_size) || 0.04) * 100;
    mobileTokenSizeSlider.value = mobileSizePercent;
    mobileTokenSizeValue.textContent = `${Number(mobileSizePercent.toFixed(1))}%`;
    vttPasswordStatus.textContent = state.vtt_password_set
      ? "Player VTT password is set. Existing players can sign in with the current password."
      : "Player VTT access is disabled until you set a shared game password.";

    renderMapLibrary();
    renderTokenList();
    renderAreaList();
    renderInitiativeList();
    renderPlayerActivity();
    if (!state.has_image) {
      previewContent.hidden = true;
      previewImage.removeAttribute("src");
      previewDarknessLayer.replaceChildren();
      previewDarknessLayer.hidden = true;
      previewGridLayer.hidden = true;
      previewAreaLayer.replaceChildren();
      previewTokenLayer.replaceChildren();
      filenameLabel.textContent = "No image loaded.";
      imageVersion = null;
      return;
    }
    filenameLabel.textContent = `${state.map_name || "Current map"} · ${state.original_filename || "Map image"}`;
    if (state.image_version !== imageVersion) {
      previewImage.src = `${state.image_url || "/current-image"}?v=${encodeURIComponent(state.image_version || 0)}`;
      imageVersion = state.image_version;
    } else {
      fitPreview();
    }
  }

  async function load() {
    await flushCardAutosaves();
    const response = await fetch("/api/editor-state", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (handleGmAuthFailure(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    apply(payload);
  }

  async function saveDisplaySettings() {
    if (!state?.map_id) return;
    await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        map_id: state?.map_id || null,
        zoom: Number(zoomSlider.value) / 100,
        background: background.value,
        grid_enabled: gridEnabled.checked,
        grid_size: Number(gridSizeSlider.value) / 100,
        grid_color: gridColor.value,
        grid_opacity: Number(gridOpacitySlider.value) / 100,
      }),
    });
  }

  function scheduleDisplaySave() {
    clearTimeout(displaySaveTimer);
    displaySaveTimer = setTimeout(() => {
      saveDisplaySettings().catch(error => showStatus(error.message, "error"));
    }, 120);
  }

  async function saveVttSettings() {
    await api("/api/vtt/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_size: Number(tokenSizeSlider.value) / 100,
        mobile_token_size: Number(mobileTokenSizeSlider.value) / 100,
        movement_enabled: movementEnabled.checked,
        dark_environment: darkEnvironment.checked,
        stack_player_vision: stackPlayerVision.checked,
        persistent_explored_fog: persistentExploredFog.checked,
      }),
    });
  }

  function scheduleVttSave() {
    clearTimeout(vttSaveTimer);
    vttSaveTimer = setTimeout(() => {
      saveVttSettings().catch(error => showStatus(error.message, "error"));
    }, 120);
  }

  uploadForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!imageInput.files.length) return showStatus("Select an image file.", "error");
    const formData = new FormData();
    formData.append("image", imageInput.files[0]);
    formData.append("name", mapNameInput?.value || "");
    try {
      await api("/edit/api/maps", { method: "POST", body: formData });
      imageInput.value = "";
      if (mapNameInput) mapNameInput.value = "";
      await load();
      showStatus("Map added to the library. It remains inactive until you choose Activate.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  zoomSlider.addEventListener("input", () => {
    if (state) state.zoom = Number(zoomSlider.value) / 100;
    zoomValue.textContent = `${zoomSlider.value}%`;
    fitPreview();
    scheduleDisplaySave();
  });
  zoomIn.addEventListener("click", () => {
    zoomSlider.value = Math.min(500, Number(zoomSlider.value) + 10);
    zoomSlider.dispatchEvent(new Event("input"));
  });
  zoomOut.addEventListener("click", () => {
    zoomSlider.value = Math.max(10, Number(zoomSlider.value) - 10);
    zoomSlider.dispatchEvent(new Event("input"));
  });
  fitButton.addEventListener("click", () => {
    zoomSlider.value = 100;
    zoomSlider.dispatchEvent(new Event("input"));
  });
  background.addEventListener("change", () => {
    if (state) state.background = background.value;
    previewStage.style.background = background.value;
    scheduleDisplaySave();
  });

  gridEnabled.addEventListener("change", () => {
    if (state) state.grid_enabled = gridEnabled.checked;
    renderPreviewGrid();
    scheduleDisplaySave();
  });
  gridSizeSlider.addEventListener("input", () => {
    const value = Number(gridSizeSlider.value);
    gridSizeValue.textContent = `${Number(value.toFixed(2))}%`;
    if (state) state.grid_size = value / 100;
    renderPreviewDarkness();
    renderPreviewGrid();
    scheduleDisplaySave();
  });
  gridColor.addEventListener("input", () => {
    if (state) state.grid_color = gridColor.value;
    renderPreviewGrid();
    scheduleDisplaySave();
  });
  gridOpacitySlider.addEventListener("input", () => {
    const value = Number(gridOpacitySlider.value);
    gridOpacityValue.textContent = `${Math.round(value)}%`;
    if (state) state.grid_opacity = value / 100;
    renderPreviewGrid();
    scheduleDisplaySave();
  });

  clearButton.addEventListener("click", async () => {
    if (!confirm("Clear the map image from the display? Tokens and VTT settings will be kept.")) return;
    try {
      await api("/api/clear", { method: "POST" });
      await load();
      showStatus("The map image was cleared. Tokens and VTT settings were preserved.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  vttPasswordForm.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/api/vtt/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: vttPassword.value, confirm: vttPasswordConfirm.value }),
      });
      vttPasswordForm.reset();
      await load();
      showStatus("Player VTT password updated. Existing player logins were invalidated.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  clearVttPassword.addEventListener("click", async () => {
    if (!confirm("Disable player VTT access? Existing player logins will stop working.")) return;
    try {
      await api("/api/vtt/password/clear", { method: "POST" });
      await load();
      showStatus("Player VTT access disabled.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  tokensVisible.addEventListener("change", async () => {
    const visible = tokensVisible.checked;
    tokensVisible.indeterminate = false;
    try {
      await flushCardAutosaves();
      await api("/api/tokens/visibility-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible }),
      });
      await load();
      showStatus(visible
        ? "All tokens are visible and may contribute vision according to their settings."
        : "All tokens are hidden. Hidden tokens do not contribute vision or reveal terrain.");
    } catch (error) {
      await load().catch(() => {});
      showStatus(error.message, "error");
    }
  });
  movementEnabled.addEventListener("change", () => {
    if (state) state.movement_enabled = movementEnabled.checked;
    scheduleVttSave();
  });
  darkEnvironment.addEventListener("change", () => {
    if (state) state.dark_environment = darkEnvironment.checked;
    renderPreviewDarkness();
    scheduleVttSave();
    showStatus(darkEnvironment.checked
      ? "Dark environment enabled. Areas outside player vision are black on player/viewer displays."
      : "Dark environment disabled.");
  });
  stackPlayerVision.addEventListener("change", () => {
    if (state) state.stack_player_vision = stackPlayerVision.checked;
    scheduleVttSave();
    showStatus(stackPlayerVision.checked
      ? "Player pages now share the combined visibility circles of all player-controlled tokens."
      : "Player pages now use only that player's own visibility circle.");
  });
  persistentExploredFog.addEventListener("change", () => {
    if (state) state.persistent_explored_fog = persistentExploredFog.checked;
    scheduleVttSave();
    showStatus(persistentExploredFog.checked
      ? "Persistent explored-area fog enabled. Previously seen terrain will remain dimly visible."
      : "Persistent explored-area fog disabled and remembered terrain cleared.");
  });
  tokenSizeSlider.addEventListener("input", () => {
    const value = Number(tokenSizeSlider.value);
    tokenSizeValue.textContent = `${Number(value.toFixed(2))}%`;
    if (state) state.token_size = value / 100;
    renderPreviewTokens();
    scheduleVttSave();
  });
  mobileTokenSizeSlider.addEventListener("input", () => {
    const value = Number(mobileTokenSizeSlider.value);
    mobileTokenSizeValue.textContent = `${Number(value.toFixed(2))}%`;
    if (state) state.mobile_token_size = value / 100;
    scheduleVttSave();
  });

  function updateNewTokenControls() {
    const isPlayerControlled = newTokenPlayerControlled.checked;
    newMovedByTokenId.disabled = isPlayerControlled;
    if (isPlayerControlled) {
      newMovedByTokenId.value = "";
    } else {
      populateDelegateSelect(newMovedByTokenId, newMovedByTokenId.value || "");
    }
  }

  newTokenPlayerControlled.addEventListener("change", updateNewTokenControls);

  addTokenForm.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const result = await api("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newTokenName.value,
          color: newTokenColor.value,
          initiative: newTokenInitiative.value,
          visible: newTokenVisible.checked,
          player_controlled: newTokenPlayerControlled.checked,
          moved_by_token_id: newMovedByTokenId.value,
        }),
      });
      addTokenForm.reset();
      newTokenVisible.checked = false;
      newTokenPlayerControlled.checked = true;
      updateNewTokenControls();
      await load();
      const nextColors = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa", "#fb8c00", "#00acc1", "#d81b60"];
      newTokenColor.value = nextColors[(state.tokens || []).length % nextColors.length];
      showStatus("Token added.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  function updateNewAreaControls() {
    const isCone = newAreaShape.value === "cone";
    const isLine = newAreaShape.value === "line";
    newAreaCircleSettings.hidden = isCone || isLine;
    newAreaConeSettings.hidden = !isCone;
    newAreaLineSettings.hidden = !isLine;
    addAreaButton.textContent = isCone ? "Add Cone" : isLine ? "Add Line" : "Add Circle";
  }

  newAreaShape.addEventListener("change", updateNewAreaControls);

  addAreaForm.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const shape = newAreaShape.value;
      const result = await api("/api/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newAreaName.value,
          shape,
          color: newAreaColor.value,
          diameter: Number(newAreaDiameter.value) / 100,
          length_squares: shape === "line" ? Number(newAreaLineLength.value) : Number(newAreaLength.value),
          width_squares: Number(newAreaLineWidth.value),
          angle: Number(newAreaAngle.value),
          rotation: shape === "line" ? Number(newAreaLineRotation.value) : Number(newAreaRotation.value),
        }),
      });
      addAreaForm.reset();
      newAreaShape.value = "circle";
      newAreaColor.value = "#e53935";
      newAreaDiameter.value = "20";
      newAreaLength.value = "6";
      newAreaAngle.value = "60";
      newAreaRotation.value = "0";
      newAreaLineLength.value = "6";
      newAreaLineWidth.value = "1";
      newAreaLineRotation.value = "0";
      updateNewAreaControls();
      await load();
      const noun = result.area.shape === "cone" ? "Cone" : result.area.shape === "line" ? "Line" : "Circle";
      const extra = result.area.shape === "circle" ? "" : " Drag its end handle to aim it.";
      showStatus(`${noun} AOE “${result.area.name}” added. Drag it on the GM preview to position it.${extra}`);
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  initiativeEnforced.addEventListener("change", async () => {
    try {
      await api("/api/initiative/enforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: initiativeEnforced.checked }),
      });
      await load();
      showStatus(initiativeEnforced.checked
        ? "Initiative enforcement enabled. Players may move only tokens allowed by the active turn."
        : "Initiative enforcement disabled. Normal player movement permissions restored.");
    } catch (error) {
      await load().catch(() => {});
      showStatus(error.message, "error");
    }
  });

  async function stepInitiative(direction) {
    try {
      const result = await api("/api/initiative/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      await load();
      showStatus(`Active initiative: ${result.active_initiative_token_name} (${result.initiative}).`);
    } catch (error) {
      showStatus(error.message, "error");
    }
  }

  initiativePreviousButton.addEventListener("click", () => stepInitiative("previous"));
  initiativeNextButton.addEventListener("click", () => stepInitiative("next"));

  clearInitiativeButton.addEventListener("click", async () => {
    if (!state?.tokens?.some(token => token.initiative !== null && token.initiative !== undefined)) {
      showStatus("No initiative numbers are currently assigned.");
      return;
    }
    if (!confirm("Are you sure you want to clear ALL initiative numbers?\n\nThis removes initiative from every player, monster, NPC, and other token and turns off initiative enforcement. Token names, colors, positions, and player links will be kept.\n\nThis cannot be undone.")) return;
    try {
      await api("/api/tokens/initiative/clear", { method: "POST" });
      await load();
      showStatus("All initiative numbers cleared and initiative enforcement disabled.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  gmPreviewDarkness.addEventListener("change", () => {
    gmPreviewDarknessVisible = gmPreviewDarkness.checked;
    renderPreviewDarkness();
    renderPreviewTokens();
  });

  expandPreviewButton.addEventListener("click", () => {
    setPreviewExpanded(!previewIsExpanded());
  });

  previewStage.addEventListener("pointerdown", beginPreviewPan);
  previewStage.addEventListener("pointermove", movePreviewPan);
  previewStage.addEventListener("pointerup", endPreviewPan);
  previewStage.addEventListener("pointercancel", endPreviewPan);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && previewIsExpanded()) {
      setPreviewExpanded(false);
      expandPreviewButton.focus();
    }
  });

  previewImage.addEventListener("load", fitPreview);
  previewImage.addEventListener("error", () => setTimeout(() => load().catch(() => {}), 1000));
  window.addEventListener("resize", fitPreview);

  updateNewTokenControls();
  updateNewAreaControls();
  load().catch(error => showStatus(error.message, "error"));
  const events = new EventSource("/events");
  events.addEventListener("update", () => {
    const tag = document.activeElement?.tagName || "";
    const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(tag);
    if (!drag && !editing && !cardAutosaveBusy()) load().catch(error => showStatus(error.message, "error"));
  });
})();
