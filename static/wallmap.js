(() => {
  "use strict";

  const app = document.getElementById("wallMapApp");
  const stage = document.getElementById("wallMapStage");
  const content = document.getElementById("wallMapContent");
  const image = document.getElementById("wallMapImage");
  const darknessLayer = document.getElementById("wallMapDarknessLayer");
  const gridLayer = document.getElementById("wallMapGridLayer");
  const areaLayer = document.getElementById("wallMapAreaLayer");
  const tokenLayer = document.getElementById("wallMapTokenLayer");
  const blockerLayer = document.getElementById("wallMapBlockerLayer");
  const gmDarkness = document.getElementById("wallMapDarkness");
  const doorColor = document.getElementById("wallMapDoorColor");
  const doorOpacity = document.getElementById("wallMapDoorOpacity");
  const doorOpacityValue = document.getElementById("wallMapDoorOpacityValue");
  const status = document.getElementById("wallMapStatus");
  const moveTool = document.getElementById("wallMapMoveTool");
  const wallTool = document.getElementById("wallMapWallTool");
  const doorTool = document.getElementById("wallMapDoorTool");
  const selectTool = document.getElementById("wallMapSelectTool");
  const finishButton = document.getElementById("wallMapFinishButton");
  const doorToggleButton = document.getElementById("wallMapDoorToggleButton");
  const doorVisibleRow = document.getElementById("wallMapDoorVisibleRow");
  const doorVisible = document.getElementById("wallMapDoorVisible");
  const deleteButton = document.getElementById("wallMapDeleteButton");
  const deleteAllButton = document.getElementById("wallMapDeleteAllButton");
  const csrf = app.dataset.csrfToken;
  const mapId = app.dataset.mapId || "";
  const mapName = document.getElementById("wallMapMapName");
  const mapMode = document.getElementById("wallMapMapMode");

  let state = null;
  let imageVersion = null;
  let drag = null;
  let mode = "move";
  let drawingStart = null;
  let selectedBlockerId = null;

  function mapScopedUrl(url) {
    if (!mapId) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}map_id=${encodeURIComponent(mapId)}`;
  }

  function handleGmAuthFailure(response, payload = {}) {
    if (response.status !== 401) return false;
    window.location.assign(payload.login_url || "/login?next=/edit/wallmap");
    return true;
  }

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("X-CSRF-Token", csrf);
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (handleGmAuthFailure(response, payload)) throw new Error("GM login is required.");
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function activeBlockers() {
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

  function visibilityPoints(source) {
    const blockers = activeBlockers();
    if (!blockers.length || !content.clientWidth || !content.clientHeight) return null;
    const aspect = content.clientHeight / content.clientWidth;
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

  function visionSourcesFromEditorState() {
    if (!state) return [];
    const sources = [];
    for (const token of state.tokens || []) {
      if (token.visible === false) continue;
      const sharedNpcVision = !token.player_controlled
        && Boolean(token.moved_by_token_id)
        && Boolean(token.share_vision_with_controller);
      if ((token.player_controlled && token.vision_enabled) || sharedNpcVision) {
        const source = {
          token_id: token.id,
          x: token.x,
          y: token.y,
          radius_feet: Number(token.vision_radius_feet) || 60,
          vision_type: token.vision_type === "nightvision" ? "nightvision" : "light",
        };
        source.points = visibilityPoints(source);
        sources.push(source);
      } else if (!token.player_controlled && token.reveal_in_darkness) {
        sources.push({
          token_id: token.id,
          x: token.x,
          y: token.y,
          radius_feet: 1,
          vision_type: "light",
        });
      }
    }
    return sources;
  }

  function fitContent() {
    if (!state || !state.has_image || !image.naturalWidth || !image.naturalHeight) return;
    const widthScale = stage.clientWidth / image.naturalWidth;
    const heightScale = stage.clientHeight / image.naturalHeight;
    const baseScale = Math.min(widthScale, heightScale);
    content.style.width = `${Math.max(1, image.naturalWidth * baseScale)}px`;
    content.style.height = `${Math.max(1, image.naturalHeight * baseScale)}px`;
    content.style.transform = "none";
    content.hidden = false;
    state.vision_sources = visionSourcesFromEditorState();
    renderDarkness();
    renderGrid();
    renderAreas();
    renderTokens();
    renderBlockers();
  }

  function addVisionRegion(parent, source, fill, width, height, gridFraction, ns) {
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
  }

  function renderDarkness() {
    darknessLayer.replaceChildren();
    if (!state || !state.dark_environment || !gmDarkness.checked || !content.clientWidth || !content.clientHeight) {
      darknessLayer.hidden = true;
      return;
    }
    const width = content.clientWidth;
    const height = content.clientHeight;
    const ns = "http://www.w3.org/2000/svg";
    const maskId = "wallMapDarknessMask";
    const nightMaskId = "wallMapNightvisionMask";
    const grayFilterId = "wallMapNightvisionGray";
    const sources = state.vision_sources || [];
    const nightSources = sources.filter(source => source.vision_type === "nightvision");
    const lightSources = sources.filter(source => source.vision_type !== "nightvision");
    const gridFraction = Math.max(0.01, Number(state.grid_size) || 0.05);
    darknessLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    darknessLayer.setAttribute("preserveAspectRatio", "none");

    const defs = document.createElementNS(ns, "defs");
    const grayFilter = document.createElementNS(ns, "filter");
    grayFilter.setAttribute("id", grayFilterId);
    grayFilter.setAttribute("color-interpolation-filters", "sRGB");
    const grayMatrix = document.createElementNS(ns, "feColorMatrix");
    grayMatrix.setAttribute("type", "saturate");
    grayMatrix.setAttribute("values", "0");
    grayFilter.appendChild(grayMatrix);
    defs.appendChild(grayFilter);

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
    for (const source of sources) addVisionRegion(darknessMask, source, "black", width, height, gridFraction, ns);
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
      for (const source of nightSources) addVisionRegion(nightMask, source, "white", width, height, gridFraction, ns);
      for (const source of lightSources) addVisionRegion(nightMask, source, "black", width, height, gridFraction, ns);
      defs.appendChild(nightMask);
    }
    darknessLayer.appendChild(defs);

    if (nightSources.length && image.currentSrc) {
      const nightImage = document.createElementNS(ns, "image");
      nightImage.setAttribute("href", image.currentSrc);
      nightImage.setAttribute("x", "0");
      nightImage.setAttribute("y", "0");
      nightImage.setAttribute("width", String(width));
      nightImage.setAttribute("height", String(height));
      nightImage.setAttribute("preserveAspectRatio", "none");
      nightImage.setAttribute("filter", `url(#${grayFilterId})`);
      nightImage.setAttribute("mask", `url(#${nightMaskId})`);
      darknessLayer.appendChild(nightImage);
    }

    const cover = document.createElementNS(ns, "rect");
    cover.setAttribute("x", "0");
    cover.setAttribute("y", "0");
    cover.setAttribute("width", String(width));
    cover.setAttribute("height", String(height));
    cover.setAttribute("fill", "#000000");
    cover.setAttribute("mask", `url(#${maskId})`);
    darknessLayer.appendChild(cover);
    darknessLayer.hidden = false;
  }

  function renderGrid() {
    if (!state || !state.grid_enabled || !content.clientWidth) {
      gridLayer.hidden = true;
      return;
    }
    const gridPixels = Math.max(4, content.clientWidth * (Number(state.grid_size) || 0.05));
    gridLayer.style.setProperty("--grid-cell", `${gridPixels}px`);
    gridLayer.style.setProperty("--grid-color", state.grid_color || "#ffffff");
    gridLayer.style.opacity = String(Math.max(0.10, Math.min(1, Number(state.grid_opacity) || 1)));
    gridLayer.hidden = false;
  }

  function renderAreas() {
    areaLayer.replaceChildren();
    if (!state || !content.clientWidth) return;
    const gridFraction = Math.max(0.01, Number(state.grid_size) || 0.05);
    for (const area of state.areas || []) {
      const areaColor = area.color || "#e53935";
      if (area.shape === "cone") {
        const lengthPixels = Math.max(8, content.clientWidth * gridFraction * (Number(area.length_squares) || 6));
        const angle = Math.max(15, Math.min(120, Number(area.angle) || 60));
        const heightPixels = Math.max(8, 2 * lengthPixels * Math.tan((angle / 2) * Math.PI / 180));
        const element = document.createElement("div");
        element.className = "map-area map-cone";
        element.style.left = `${area.x * 100}%`;
        element.style.top = `${area.y * 100}%`;
        element.style.width = `${lengthPixels}px`;
        element.style.height = `${heightPixels}px`;
        element.style.transform = `translate(0, -50%) rotate(${Number(area.rotation) || 0}deg)`;
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
        svg.appendChild(polygon);
        element.appendChild(svg);
        areaLayer.appendChild(element);
      } else if (area.shape === "line") {
        const lengthPixels = Math.max(8, content.clientWidth * gridFraction * (Number(area.length_squares) || 6));
        const widthPixels = Math.max(4, content.clientWidth * gridFraction * (Number(area.width_squares) || 1));
        const element = document.createElement("div");
        element.className = "map-area map-line";
        element.style.left = `${area.x * 100}%`;
        element.style.top = `${area.y * 100}%`;
        element.style.width = `${lengthPixels}px`;
        element.style.height = `${widthPixels}px`;
        element.style.transform = `translate(0, -50%) rotate(${Number(area.rotation) || 0}deg)`;
        const body = document.createElement("div");
        body.className = "line-shape";
        body.style.borderColor = areaColor;
        body.style.backgroundColor = `${areaColor}47`;
        element.appendChild(body);
        areaLayer.appendChild(element);
      } else {
        const diameterPixels = Math.max(4, content.clientWidth * (Number(area.diameter) || 0.20));
        const element = document.createElement("div");
        element.className = "map-area map-circle";
        element.style.left = `${area.x * 100}%`;
        element.style.top = `${area.y * 100}%`;
        element.style.width = `${diameterPixels}px`;
        element.style.height = `${diameterPixels}px`;
        element.style.backgroundColor = `${areaColor}47`;
        element.style.borderColor = areaColor;
        areaLayer.appendChild(element);
      }
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
    initiative.style.fontSize = `${Math.max(7, Math.min(28, tokenPixels * (value.length >= 3 ? 0.32 : 0.42)))}px`;
    element.appendChild(initiative);
  }

  function positionFromPointer(event) {
    const rect = content.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function setMode(nextMode) {
    mode = nextMode;
    drawingStart = null;
    finishButton.disabled = true;
    for (const [button, value] of [[moveTool, "move"], [wallTool, "wall"], [doorTool, "door"], [selectTool, "select"]]) {
      const active = value === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    content.dataset.wallMode = mode;
    status.textContent = mode === "move" ? "Drag a token to move it."
      : mode === "wall" ? "Click wall corners in order. Each new click adds a segment."
      : mode === "door" ? "Click the two ends of a door opening."
      : "Click a wall or door to select it.";
    renderBlockers();
  }

  function selectBlocker(id) {
    selectedBlockerId = id || null;
    const blocker = (state?.vision_blockers || []).find(item => item.id === selectedBlockerId);
    deleteButton.disabled = !blocker;
    const doorSelected = Boolean(blocker && blocker.type === "door");
    doorToggleButton.disabled = !doorSelected;
    doorToggleButton.textContent = doorSelected && blocker.open ? "Close door" : "Open door";
    doorVisibleRow.hidden = !doorSelected;
    doorVisible.disabled = !doorSelected;
    doorVisible.checked = doorSelected ? blocker.visible_to_players !== false : false;
    renderBlockers();
  }

  async function createBlocker(type, start, end) {
    await api(mapScopedUrl("/api/vision-blockers"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type, x1: start.x, y1: start.y, x2: end.x, y2: end.y,
        open: false, visible_to_players: type === "door",
      }),
    });
    await load();
  }

  async function handleMapPointer(event) {
    if (event.button !== 0 || (mode !== "wall" && mode !== "door")) return;
    event.preventDefault();
    const point = positionFromPointer(event);
    if (!point) return;
    if (!drawingStart) {
      drawingStart = point;
      finishButton.disabled = false;
      status.textContent = mode === "wall" ? "Wall started. Click the next corner." : "Door started. Click the other end.";
      renderBlockers();
      return;
    }
    const start = drawingStart;
    try {
      await createBlocker(mode === "wall" ? "wall" : "door", start, point);
      if (mode === "wall") {
        drawingStart = point;
        finishButton.disabled = false;
        status.textContent = "Wall segment added. Continue clicking corners or choose Finish wall.";
      } else {
        drawingStart = null;
        finishButton.disabled = true;
        status.textContent = "Door added. Draw another door or choose another tool.";
      }
      renderBlockers();
    } catch (error) {
      status.textContent = `Could not add blocker: ${error.message}`;
    }
  }

  function beginTokenDrag(event, token, element) {
    if (mode !== "move" || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { pointerId: event.pointerId, token, element, startX: token.x, startY: token.y };
    element.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
  }

  function moveTokenDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = positionFromPointer(event);
    if (!position) return;
    drag.token.x = position.x;
    drag.token.y = position.y;
    drag.element.style.left = `${position.x * 100}%`;
    drag.element.style.top = `${position.y * 100}%`;
    if (
      (drag.token.player_controlled && drag.token.vision_enabled)
      || (!drag.token.player_controlled && drag.token.moved_by_token_id && drag.token.share_vision_with_controller)
      || drag.token.reveal_in_darkness
    ) {
      state.vision_sources = visionSourcesFromEditorState();
      renderDarkness();
    }
  }

  async function endTokenDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.element.classList.remove("dragging");
    try {
      await api(`/api/tokens/${encodeURIComponent(current.token.id)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: current.token.x, y: current.token.y }),
      });
      status.textContent = `Moved ${current.token.name}.`;
      await load();
    } catch (error) {
      status.textContent = `Move failed: ${error.message}`;
      await load();
    }
  }

  function cancelTokenDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.element.classList.remove("dragging");
    current.token.x = current.startX;
    current.token.y = current.startY;
    current.element.style.left = `${current.startX * 100}%`;
    current.element.style.top = `${current.startY * 100}%`;
    state.vision_sources = visionSourcesFromEditorState();
    renderDarkness();
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

  function npcVisibleInGmDarkness(token) {
    if (!state || token.player_controlled || !state.dark_environment || !gmDarkness.checked) return true;
    if (token.reveal_in_darkness) return true;
    for (const source of state.vision_sources || []) {
      const sourceToken = (state.tokens || []).find(item => item.id === source.token_id);
      if (!sourceToken?.player_controlled) continue;
      if (Array.isArray(source.points) && source.points.length >= 3) {
        if (pointInPolygon(Number(token.x), Number(token.y), source.points)) return true;
      } else {
        const aspect = content.clientHeight / content.clientWidth;
        const radius = Math.max(0.01, Number(state.grid_size) || 0.05) * ((Number(source.radius_feet) || 60) / 5);
        const dx = Number(token.x) - Number(source.x);
        const dy = (Number(token.y) - Number(source.y)) * aspect;
        if (dx * dx + dy * dy <= radius * radius) return true;
      }
    }
    return false;
  }

  function renderTokens() {
    tokenLayer.replaceChildren();
    if (!state || !content.clientWidth) return;
    const tokenPixels = Math.max(8, content.clientWidth * (Number(state.token_size) || 0.04));
    for (const token of state.tokens || []) {
      if (!npcVisibleInGmDarkness(token)) continue;
      const element = document.createElement("div");
      element.className = "map-token draggable-token admin-token";
      if (token.visible === false) element.classList.add("token-hidden-admin");
      element.style.left = `${token.x * 100}%`;
      element.style.top = `${token.y * 100}%`;
      element.style.width = `${tokenPixels}px`;
      element.style.height = `${tokenPixels}px`;
      element.style.backgroundColor = token.color;
      addInitiativeNumber(element, token, tokenPixels);
      const label = document.createElement("span");
      label.className = "token-label";
      label.textContent = token.name;
      element.appendChild(label);
      element.addEventListener("pointerdown", event => beginTokenDrag(event, token, element));
      element.addEventListener("pointermove", moveTokenDrag);
      element.addEventListener("pointerup", endTokenDrag);
      element.addEventListener("pointercancel", cancelTokenDrag);
      tokenLayer.appendChild(element);
    }
  }

  function renderBlockers() {
    blockerLayer.replaceChildren();
    if (!state || !content.clientWidth || !content.clientHeight) return;
    const width = content.clientWidth;
    const height = content.clientHeight;
    const ns = "http://www.w3.org/2000/svg";
    blockerLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    blockerLayer.setAttribute("preserveAspectRatio", "none");

    for (const blocker of state.vision_blockers || []) {
      const line = document.createElementNS(ns, "line");
      line.classList.add("wallmap-blocker-line", blocker.type === "door" ? "wallmap-door-line" : "wallmap-wall-line");
      if (blocker.type === "door" && blocker.open) line.classList.add("wallmap-door-open");
      if (blocker.type === "door" && blocker.visible_to_players === false) {
        line.classList.add("wallmap-door-hidden");
      } else if (blocker.type === "door") {
        line.style.stroke = state?.door_color || "#ffd54d";
        line.style.opacity = String(Math.max(0.10, Math.min(1, Number(state?.door_opacity) || 0.72)));
      }
      if (blocker.id === selectedBlockerId) line.classList.add("selected");
      line.setAttribute("x1", String(Number(blocker.x1) * width));
      line.setAttribute("y1", String(Number(blocker.y1) * height));
      line.setAttribute("x2", String(Number(blocker.x2) * width));
      line.setAttribute("y2", String(Number(blocker.y2) * height));
      line.dataset.blockerId = blocker.id;
      const hitLine = line.cloneNode(false);
      hitLine.setAttribute("class", "wallmap-blocker-hit");
      hitLine.addEventListener("pointerdown", event => {
        if (mode !== "select") return;
        event.preventDefault();
        event.stopPropagation();
        selectBlocker(blocker.id);
        status.textContent = blocker.type === "door" ? (blocker.open ? "Open door selected." : "Closed door selected.") : "Wall selected.";
      });
      blockerLayer.append(hitLine, line);
    }

    if (drawingStart) {
      const marker = document.createElementNS(ns, "circle");
      marker.classList.add("wallmap-drawing-point");
      marker.setAttribute("cx", String(drawingStart.x * width));
      marker.setAttribute("cy", String(drawingStart.y * height));
      marker.setAttribute("r", "5");
      blockerLayer.appendChild(marker);
    }
  }

  function apply(nextState) {
    state = nextState;
    if (mapName) mapName.textContent = state.map_name || "Map";
    if (mapMode) mapMode.textContent = state.map_is_active ? "ACTIVE MAP" : "INACTIVE PREP";
    moveTool.disabled = !state.map_is_active;
    if (!state.map_is_active && mode === "move") setMode("wall");
    state.vision_sources = visionSourcesFromEditorState();
    stage.style.background = state.background || "#000000";
    doorColor.value = state.door_color || "#ffd54d";
    doorOpacity.value = String(Math.round((Number(state.door_opacity) || 0.72) * 100));
    doorOpacityValue.textContent = `${doorOpacity.value}%`;
    deleteAllButton.disabled = !(state.vision_blockers || []).length;
    if (selectedBlockerId && !(state.vision_blockers || []).some(item => item.id === selectedBlockerId)) {
      selectedBlockerId = null;
    }
    selectBlocker(selectedBlockerId);
    if (!state.has_image) {
      content.hidden = true;
      image.removeAttribute("src");
      darknessLayer.replaceChildren();
      darknessLayer.hidden = true;
      gridLayer.hidden = true;
      areaLayer.replaceChildren();
      tokenLayer.replaceChildren();
      blockerLayer.replaceChildren();
      imageVersion = null;
      return;
    }
    if (state.image_version !== imageVersion) {
      image.src = `${state.image_url || "/current-image"}?v=${encodeURIComponent(state.image_version || 0)}`;
      imageVersion = state.image_version;
    } else {
      fitContent();
    }
  }

  async function load() {
    try {
      const response = await fetch(mapScopedUrl("/api/editor-state"), { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (handleGmAuthFailure(response, payload)) return;
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      apply(payload);
    } catch (error) {
      console.error("GM wall map state load failed", error);
      status.textContent = `Connection problem: ${error.message}`;
    }
  }

  async function saveDoorStyle() {
    const requestedColor = doorColor.value;
    const requestedOpacity = Number(doorOpacity.value) / 100;
    try {
      await api(mapScopedUrl("/api/vision-blockers/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ door_color: requestedColor, door_opacity: requestedOpacity }),
      });
      if (state) {
        state.door_color = requestedColor;
        state.door_opacity = requestedOpacity;
      }
      status.textContent = `Door appearance updated: ${doorOpacity.value}% opacity.`;
      renderBlockers();
    } catch (error) {
      status.textContent = `Door appearance update failed: ${error.message}`;
      await load();
    }
  }

  doorColor.addEventListener("input", () => {
    if (state) state.door_color = doorColor.value;
    renderBlockers();
  });
  doorColor.addEventListener("change", saveDoorStyle);
  doorOpacity.addEventListener("input", () => {
    doorOpacityValue.textContent = `${doorOpacity.value}%`;
    if (state) state.door_opacity = Number(doorOpacity.value) / 100;
    renderBlockers();
  });
  doorOpacity.addEventListener("change", saveDoorStyle);

  moveTool.addEventListener("click", () => setMode("move"));
  wallTool.addEventListener("click", () => setMode("wall"));
  doorTool.addEventListener("click", () => setMode("door"));
  selectTool.addEventListener("click", () => setMode("select"));
  finishButton.addEventListener("click", () => {
    drawingStart = null;
    finishButton.disabled = true;
    status.textContent = "Wall finished.";
    renderBlockers();
  });
  doorToggleButton.addEventListener("click", async () => {
    const blocker = (state?.vision_blockers || []).find(item => item.id === selectedBlockerId);
    if (!blocker || blocker.type !== "door") return;
    try {
      await api(mapScopedUrl(`/api/vision-blockers/${encodeURIComponent(blocker.id)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ open: !blocker.open }),
      });
      status.textContent = blocker.open ? "Door closed." : "Door opened.";
      await load();
      selectBlocker(blocker.id);
    } catch (error) {
      status.textContent = `Door update failed: ${error.message}`;
    }
  });
  doorVisible.addEventListener("change", async () => {
    const blocker = (state?.vision_blockers || []).find(item => item.id === selectedBlockerId);
    if (!blocker || blocker.type !== "door") return;
    try {
      await api(mapScopedUrl(`/api/vision-blockers/${encodeURIComponent(blocker.id)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible_to_players: doorVisible.checked }),
      });
      status.textContent = doorVisible.checked
        ? "Door will be shown faintly when players can see it."
        : "Door is hidden from players.";
      await load();
      selectBlocker(blocker.id);
    } catch (error) {
      doorVisible.checked = blocker.visible_to_players !== false;
      status.textContent = `Door visibility update failed: ${error.message}`;
    }
  });

  deleteButton.addEventListener("click", async () => {
    const blocker = (state?.vision_blockers || []).find(item => item.id === selectedBlockerId);
    if (!blocker) return;
    if (!window.confirm(`Delete this ${blocker.type}?`)) return;
    try {
      await api(mapScopedUrl(`/api/vision-blockers/${encodeURIComponent(blocker.id)}`), { method: "DELETE" });
      selectBlocker(null);
      status.textContent = `${blocker.type === "door" ? "Door" : "Wall"} deleted.`;
      await load();
    } catch (error) {
      status.textContent = `Delete failed: ${error.message}`;
    }
  });

  deleteAllButton.addEventListener("click", async () => {
    const count = (state?.vision_blockers || []).length;
    if (!count) return;
    const itemWord = count === 1 ? "item" : "items";
    if (!window.confirm(`Are you sure you want to delete all walls and doors? This will remove ${count} ${itemWord} and cannot be undone.`)) return;
    try {
      const result = await api(mapScopedUrl("/api/vision-blockers"), { method: "DELETE" });
      drawingStart = null;
      finishButton.disabled = true;
      selectBlocker(null);
      const deleted = Number(result.deleted) || count;
      status.textContent = `Deleted ${deleted} wall/door ${deleted === 1 ? "item" : "items"}.`;
      await load();
    } catch (error) {
      status.textContent = `Delete all failed: ${error.message}`;
    }
  });

  content.addEventListener("pointerdown", handleMapPointer);
  image.addEventListener("load", fitContent);
  image.addEventListener("error", () => setTimeout(load, 1000));
  window.addEventListener("resize", fitContent);
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Enter") {
      if (drawingStart) {
        drawingStart = null;
        finishButton.disabled = true;
        renderBlockers();
        status.textContent = "Drawing finished.";
      }
    }
  });
  gmDarkness.addEventListener("change", () => {
    renderDarkness();
    renderTokens();
  });

  setMode("move");
  load();
  const events = new EventSource("/events");
  events.addEventListener("update", load);
})();
