(() => {
  "use strict";
  const scopedUrl = (path) => `${window.VTT_BASE || ""}${path}`;

  const app = document.getElementById("vttApp");
  const csrf = app.dataset.csrfToken;
  const stage = app;
  const content = document.getElementById("mapContent");
  const image = document.getElementById("mapImage");
  const darknessLayer = document.getElementById("darknessLayer");
  const doorLayer = document.getElementById("doorLayer");
  const gridLayer = document.getElementById("gridLayer");
  const areaLayer = document.getElementById("areaLayer");
  const tokenLayer = document.getElementById("tokenLayer");
  const currentInitiative = document.getElementById("currentInitiative");
  const recentMoves = document.getElementById("recentMoves");
  const movementStatus = document.getElementById("movementStatus");
  const playerName = document.getElementById("playerName");

  let state = null;
  let imageVersion = null;
  let drag = null;
  const coarsePointer = window.matchMedia("(pointer: coarse)");
  const MAX_DRAG_PATH_POINTS = 512;
  const DRAG_PATH_MIN_STEP = 0.0005;

  function displayedTokenSize() {
    const normal = Number(state && state.token_size) || 0.04;
    if (!coarsePointer.matches) return normal;
    return Number(state && state.mobile_token_size) || normal;
  }

  function tokenIsMovableByPlayer(tokenId) {
    if (!state) return false;
    return Array.isArray(state.movable_token_ids) && state.movable_token_ids.includes(tokenId);
  }

  function fitContent() {
    if (!state || !state.has_image || !image.naturalWidth || !image.naturalHeight) return;
    const widthScale = stage.clientWidth / image.naturalWidth;
    const heightScale = stage.clientHeight / image.naturalHeight;
    const baseScale = Math.min(1, widthScale, heightScale);
    content.style.width = `${Math.max(1, image.naturalWidth * baseScale)}px`;
    content.style.height = `${Math.max(1, image.naturalHeight * baseScale)}px`;
    content.style.transform = `scale(${Number(state.zoom) || 1})`;
    content.hidden = false;
    renderDarkness();
    renderVisibleDoors();
    renderGrid();
    renderAreas();
    renderTokens();
  }

  function positionFromPointer(event) {
    const rect = content.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  async function saveOwnPosition(position) {
    const response = await fetch(scopedUrl("/api/vtt/move"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(position),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.reload();
      return;
    }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  }

  function appendDragPathPoint(position) {
    if (!drag || !position) return;
    const path = drag.path;
    const last = path[path.length - 1];
    if (last && Math.hypot(position.x - last.x, position.y - last.y) < DRAG_PATH_MIN_STEP) return;
    path.push({ x: position.x, y: position.y });
    if (path.length <= MAX_DRAG_PATH_POINTS) return;

    const compacted = [path[0]];
    for (let index = 2; index < path.length; index += 2) compacted.push(path[index]);
    if (compacted[compacted.length - 1] !== path[path.length - 1]) compacted.push(path[path.length - 1]);
    drag.path = compacted;
  }

  function beginDrag(event, token, element) {
    if (!state.movement_enabled || !tokenIsMovableByPlayer(token.id)) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      token,
      element,
      startX: token.x,
      startY: token.y,
      path: [{ x: token.x, y: token.y }],
    };
    element.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
  }

  function moveDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = positionFromPointer(event);
    if (!position) return;
    appendDragPathPoint(position);
    drag.token.x = position.x;
    drag.token.y = position.y;
    drag.element.style.left = `${position.x * 100}%`;
    drag.element.style.top = `${position.y * 100}%`;
    const source = (state.vision_sources || []).find(item => item.token_id === drag.token.id);
    if (source && !Array.isArray(source.points)) {
      source.x = position.x;
      source.y = position.y;
      renderDarkness();
    }
  }

  async function endDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.element.classList.remove("dragging");
    try {
      const finalPoint = { x: current.token.x, y: current.token.y };
      const lastPoint = current.path[current.path.length - 1];
      if (!lastPoint || Math.hypot(finalPoint.x - lastPoint.x, finalPoint.y - lastPoint.y) > 1e-9) {
        current.path.push(finalPoint);
      }
      await saveOwnPosition({
        token_id: current.token.id,
        x: current.token.x,
        y: current.token.y,
        path: current.path,
      });
      await load();
    } catch (error) {
      movementStatus.textContent = error.message;
      movementStatus.classList.add("locked");
      await load();
    }
  }

  function cancelDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.element.classList.remove("dragging");
    current.token.x = current.startX;
    current.token.y = current.startY;
    current.element.style.left = `${current.startX * 100}%`;
    current.element.style.top = `${current.startY * 100}%`;
    const source = (state.vision_sources || []).find(item => item.token_id === current.token.id);
    if (source && !Array.isArray(source.points)) {
      source.x = current.startX;
      source.y = current.startY;
      renderDarkness();
    }
  }

  function renderDarkness() {
    darknessLayer.replaceChildren();
    if (!state || !content.clientWidth || !content.clientHeight) {
      darknessLayer.hidden = true;
      return;
    }

    const dark = Boolean(state.dark_environment);
    const terrainOcclusion = Boolean(state.terrain_occlusion);
    const persistentFog = Boolean(state.persistent_explored_fog && state.explored_mask_png);
    if (!dark && !terrainOcclusion) {
      darknessLayer.hidden = true;
      return;
    }

    const width = content.clientWidth;
    const height = content.clientHeight;
    const ns = "http://www.w3.org/2000/svg";
    const maskId = "vttDarknessMask";
    const terrainMaskId = "vttTerrainLosMask";
    const nightMaskId = "vttNightvisionMask";
    const grayFilterId = "vttNightvisionGray";
    const exploredInvertFilterId = "vttExploredInvert";
    const unexploredMaskId = "vttUnexploredMask";
    const exploredDimMaskId = "vttExploredDimMask";
    const sources = dark ? (state.vision_sources || []) : (state.line_of_sight_sources || []);
    darknessLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    darknessLayer.setAttribute("preserveAspectRatio", "none");

    const defs = document.createElementNS(ns, "defs");
    const addPolygonRegion = (parent, source, fill) => {
      if (!Array.isArray(source.points) || source.points.length < 3) return false;
      const polygon = document.createElementNS(ns, "polygon");
      polygon.setAttribute("points", source.points
        .map(point => `${Number(point[0]) * width},${Number(point[1]) * height}`)
        .join(" "));
      polygon.setAttribute("fill", fill);
      parent.appendChild(polygon);
      return true;
    };

    const gridFraction = Math.max(0.01, Number(state.grid_size) || 0.05);
    const addCurrentRegion = (parent, source, fill) => {
      if (addPolygonRegion(parent, source, fill)) return;
      if (!dark) return;
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", String((Number(source.x) || 0) * width));
      circle.setAttribute("cy", String((Number(source.y) || 0) * height));
      circle.setAttribute("r", String(Math.max(1, width * gridFraction * ((Number(source.radius_feet) || 60) / 5))));
      circle.setAttribute("fill", fill);
      parent.appendChild(circle);
    };

    const appendExploredImage = (parent, filter = null) => {
      const exploredImage = document.createElementNS(ns, "image");
      exploredImage.setAttribute("href", `data:image/png;base64,${state.explored_mask_png}`);
      exploredImage.setAttribute("x", "0");
      exploredImage.setAttribute("y", "0");
      exploredImage.setAttribute("width", String(width));
      exploredImage.setAttribute("height", String(height));
      exploredImage.setAttribute("preserveAspectRatio", "none");
      if (filter) exploredImage.setAttribute("filter", filter);
      parent.appendChild(exploredImage);
    };

    const appendPersistentFogCovers = () => {
      const invertFilter = document.createElementNS(ns, "filter");
      invertFilter.setAttribute("id", exploredInvertFilterId);
      const invertMatrix = document.createElementNS(ns, "feColorMatrix");
      invertMatrix.setAttribute("type", "matrix");
      invertMatrix.setAttribute("values", "-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0");
      invertFilter.appendChild(invertMatrix);
      defs.appendChild(invertFilter);

      const unexploredMask = document.createElementNS(ns, "mask");
      unexploredMask.setAttribute("id", unexploredMaskId);
      unexploredMask.setAttribute("maskUnits", "userSpaceOnUse");
      unexploredMask.setAttribute("x", "0");
      unexploredMask.setAttribute("y", "0");
      unexploredMask.setAttribute("width", String(width));
      unexploredMask.setAttribute("height", String(height));
      const unexploredBase = document.createElementNS(ns, "rect");
      unexploredBase.setAttribute("x", "0");
      unexploredBase.setAttribute("y", "0");
      unexploredBase.setAttribute("width", String(width));
      unexploredBase.setAttribute("height", String(height));
      unexploredBase.setAttribute("fill", "white");
      unexploredMask.appendChild(unexploredBase);
      appendExploredImage(unexploredMask, `url(#${exploredInvertFilterId})`);
      for (const source of sources) addCurrentRegion(unexploredMask, source, "black");
      defs.appendChild(unexploredMask);

      const exploredDimMask = document.createElementNS(ns, "mask");
      exploredDimMask.setAttribute("id", exploredDimMaskId);
      exploredDimMask.setAttribute("maskUnits", "userSpaceOnUse");
      exploredDimMask.setAttribute("x", "0");
      exploredDimMask.setAttribute("y", "0");
      exploredDimMask.setAttribute("width", String(width));
      exploredDimMask.setAttribute("height", String(height));
      const dimBase = document.createElementNS(ns, "rect");
      dimBase.setAttribute("x", "0");
      dimBase.setAttribute("y", "0");
      dimBase.setAttribute("width", String(width));
      dimBase.setAttribute("height", String(height));
      dimBase.setAttribute("fill", "black");
      exploredDimMask.appendChild(dimBase);
      appendExploredImage(exploredDimMask);
      for (const source of sources) addCurrentRegion(exploredDimMask, source, "black");
      defs.appendChild(exploredDimMask);

      const unexploredCover = document.createElementNS(ns, "rect");
      unexploredCover.setAttribute("x", "0");
      unexploredCover.setAttribute("y", "0");
      unexploredCover.setAttribute("width", String(width));
      unexploredCover.setAttribute("height", String(height));
      unexploredCover.setAttribute("fill", "#000000");
      unexploredCover.setAttribute("mask", `url(#${unexploredMaskId})`);
      const dimCover = document.createElementNS(ns, "rect");
      dimCover.setAttribute("x", "0");
      dimCover.setAttribute("y", "0");
      dimCover.setAttribute("width", String(width));
      dimCover.setAttribute("height", String(height));
      dimCover.setAttribute("fill", "#000000");
      dimCover.setAttribute("opacity", "0.58");
      dimCover.setAttribute("mask", `url(#${exploredDimMaskId})`);
      return [unexploredCover, dimCover];
    };

    if (!dark) {
      if (persistentFog) {
        const persistentCovers = appendPersistentFogCovers();
        darknessLayer.appendChild(defs);
        darknessLayer.append(...persistentCovers);
      } else {
        const terrainMask = document.createElementNS(ns, "mask");
        terrainMask.setAttribute("id", terrainMaskId);
        terrainMask.setAttribute("maskUnits", "userSpaceOnUse");
        terrainMask.setAttribute("x", "0");
        terrainMask.setAttribute("y", "0");
        terrainMask.setAttribute("width", String(width));
        terrainMask.setAttribute("height", String(height));
        const terrainBase = document.createElementNS(ns, "rect");
        terrainBase.setAttribute("x", "0");
        terrainBase.setAttribute("y", "0");
        terrainBase.setAttribute("width", String(width));
        terrainBase.setAttribute("height", String(height));
        terrainBase.setAttribute("fill", "white");
        terrainMask.appendChild(terrainBase);
        for (const source of sources) addPolygonRegion(terrainMask, source, "black");
        defs.appendChild(terrainMask);
        darknessLayer.appendChild(defs);

        const cover = document.createElementNS(ns, "rect");
        cover.setAttribute("x", "0");
        cover.setAttribute("y", "0");
        cover.setAttribute("width", String(width));
        cover.setAttribute("height", String(height));
        cover.setAttribute("fill", "#000000");
        cover.setAttribute("mask", `url(#${terrainMaskId})`);
        darknessLayer.appendChild(cover);
      }
      darknessLayer.hidden = false;
      return;
    }

    const nightSources = sources.filter(source => source.vision_type === "nightvision");
    const lightSources = sources.filter(source => source.vision_type !== "nightvision");
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
    for (const source of sources) addCurrentRegion(darknessMask, source, "black");
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
      for (const source of nightSources) addCurrentRegion(nightMask, source, "white");
      for (const source of lightSources) addCurrentRegion(nightMask, source, "black");
      defs.appendChild(nightMask);
    }

    const persistentCovers = persistentFog ? appendPersistentFogCovers() : [];
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

    if (persistentFog) {
      darknessLayer.append(...persistentCovers);
    } else {
      const cover = document.createElementNS(ns, "rect");
      cover.setAttribute("x", "0");
      cover.setAttribute("y", "0");
      cover.setAttribute("width", String(width));
      cover.setAttribute("height", String(height));
      cover.setAttribute("fill", "#000000");
      cover.setAttribute("mask", `url(#${maskId})`);
      darknessLayer.appendChild(cover);
    }
    darknessLayer.hidden = false;
  }

  function renderVisibleDoors() {
    doorLayer.replaceChildren();
    const doors = state && Array.isArray(state.visible_doors) ? state.visible_doors : [];
    if (!state || !doors.length || !content.clientWidth || !content.clientHeight) {
      doorLayer.hidden = true;
      return;
    }

    const width = content.clientWidth;
    const height = content.clientHeight;
    const ns = "http://www.w3.org/2000/svg";
    const clipId = "vttPublicDoorVisionClip";
    const gridFraction = Math.max(0.01, Number(state.grid_size) || 0.05);
    const clipSources = state.dark_environment
      ? (state.vision_sources || []).filter(item => item.door_vision !== false)
      : (state.line_of_sight_sources || []).filter(item => item.door_vision !== false);
    const needsClip = Boolean(state.dark_environment || state.terrain_occlusion);
    doorLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    doorLayer.setAttribute("preserveAspectRatio", "none");

    const defs = document.createElementNS(ns, "defs");
    let clip = null;
    if (needsClip) {
      clip = document.createElementNS(ns, "clipPath");
      clip.setAttribute("id", clipId);
      clip.setAttribute("clipPathUnits", "userSpaceOnUse");
      for (const source of clipSources) {
        if (Array.isArray(source.points) && source.points.length >= 3) {
          const polygon = document.createElementNS(ns, "polygon");
          polygon.setAttribute("points", source.points
            .map(point => `${Number(point[0]) * width},${Number(point[1]) * height}`)
            .join(" "));
          clip.appendChild(polygon);
        } else if (state.dark_environment) {
          const circle = document.createElementNS(ns, "circle");
          circle.setAttribute("cx", String((Number(source.x) || 0) * width));
          circle.setAttribute("cy", String((Number(source.y) || 0) * height));
          circle.setAttribute("r", String(Math.max(1, width * gridFraction * ((Number(source.radius_feet) || 60) / 5))));
          clip.appendChild(circle);
        }
      }
      defs.appendChild(clip);
    }

    const group = document.createElementNS(ns, "g");
    if (needsClip) group.setAttribute("clip-path", `url(#${clipId})`);
    for (const door of doors) {
      const line = document.createElementNS(ns, "line");
      line.classList.add("public-door-line");
      if (door.open) line.classList.add("public-door-open");
      line.style.stroke = state.door_color || "#ffd54d";
      line.style.opacity = String(Math.max(0.10, Math.min(1, Number(state.door_opacity) || 0.72)));
      line.setAttribute("x1", String(Number(door.x1) * width));
      line.setAttribute("y1", String(Number(door.y1) * height));
      line.setAttribute("x2", String(Number(door.x2) * width));
      line.setAttribute("y2", String(Number(door.y2) * height));
      group.appendChild(line);
    }

    if (needsClip) doorLayer.append(defs, group);
    else doorLayer.append(group);
    doorLayer.hidden = false;
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
        element.style.setProperty("--area-color", areaColor);
        element.style.backgroundColor = `${areaColor}47`;
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
        element.style.setProperty("--area-color", areaColor);
        element.style.backgroundColor = `${areaColor}47`;
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
    const ratio = value.length >= 3 ? 0.32 : 0.42;
    initiative.style.fontSize = `${Math.max(7, Math.min(28, tokenPixels * ratio))}px`;
    element.appendChild(initiative);
  }

  function renderTokens() {
    tokenLayer.replaceChildren();
    if (!state || !content.clientWidth) return;
    const tokenPixels = Math.max(8, content.clientWidth * displayedTokenSize());
    for (const token of state.tokens || []) {
      const element = document.createElement("div");
      const own = token.id === state.own_token_id;
      const movable = tokenIsMovableByPlayer(token.id);
      element.className = `map-token ${movable ? "own-token" : "readonly-token"}`;
      if (movable && state.movement_enabled) element.classList.add("draggable-token");
      element.style.left = `${token.x * 100}%`;
      element.style.top = `${token.y * 100}%`;
      element.style.width = `${tokenPixels}px`;
      element.style.height = `${tokenPixels}px`;
      element.style.backgroundColor = token.color;
      element.dataset.tokenId = token.id;
      element.setAttribute("aria-label", token.initiative === null || token.initiative === undefined
        ? token.name
        : `${token.name}, initiative ${token.initiative}`);
      addInitiativeNumber(element, token, tokenPixels);

      const label = document.createElement("span");
      label.className = "token-label";
      label.textContent = token.name;
      element.appendChild(label);

      if (movable) {
        element.addEventListener("pointerdown", event => beginDrag(event, token, element));
        element.addEventListener("pointermove", moveDrag);
        element.addEventListener("pointerup", endDrag);
        element.addEventListener("pointercancel", cancelDrag);
      }
      tokenLayer.appendChild(element);
    }
  }

  function renderCurrentInitiative() {
    if (!currentInitiative) return;
    currentInitiative.replaceChildren();
    if (!state || !state.initiative_enforced || !state.current_initiative) {
      currentInitiative.hidden = true;
      return;
    }

    const title = document.createElement("div");
    title.className = "current-initiative-title";
    title.textContent = "Current initiative";

    const value = document.createElement("div");
    value.className = "current-initiative-value";
    const info = state.current_initiative;
    if (info.visible === false) {
      value.textContent = "Hidden token";
    } else {
      const initiative = Number.isFinite(Number(info.initiative)) ? ` - ${info.initiative}` : "";
      value.textContent = `${info.token_name || "Token"}${initiative}`;
    }

    currentInitiative.append(title, value);
    currentInitiative.hidden = false;
  }

  function renderRecentMoves() {
    if (!recentMoves) return;
    const moves = (state && Array.isArray(state.recent_moves)) ? state.recent_moves.slice(0, 2) : [];
    recentMoves.replaceChildren();
    if (!moves.length) {
      recentMoves.hidden = true;
      return;
    }

    const title = document.createElement("div");
    title.className = "recent-moves-title";
    title.textContent = "Recent moves";
    recentMoves.appendChild(title);

    for (const move of moves) {
      const row = document.createElement("div");
      row.className = "recent-move-row";

      const time = document.createElement("time");
      time.className = "recent-move-time";
      const stamp = new Date(move.timestamp);
      time.textContent = Number.isNaN(stamp.getTime())
        ? ""
        : stamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      if (move.timestamp) time.dateTime = move.timestamp;

      const description = document.createElement("span");
      description.className = "recent-move-description";
      description.textContent = `${move.moved_by || "GM"} moved ${move.token_name || "token"}`;

      row.append(time, description);
      recentMoves.appendChild(row);
    }
    recentMoves.hidden = false;
  }

  function apply(nextState) {
    state = nextState;
    renderCurrentInitiative();
    renderRecentMoves();
    stage.style.background = state.background || "#000000";
    playerName.textContent = state.player_name || playerName.textContent;
    if (state.own_token_visible === false && !(state.movable_token_ids || []).length) {
      movementStatus.textContent = "Your movable token is hidden by GM";
      movementStatus.classList.add("locked");
    } else if (!state.movement_enabled) {
      movementStatus.textContent = "Movement locked";
      movementStatus.classList.add("locked");
    } else if (state.initiative_enforced) {
      const canMoveThisTurn = Array.isArray(state.movable_token_ids) && state.movable_token_ids.length > 0;
      movementStatus.textContent = canMoveThisTurn
        ? "Initiative enforced - your turn"
        : "Initiative enforced - waiting";
      movementStatus.classList.toggle("locked", !canMoveThisTurn);
    } else {
      movementStatus.textContent = "Movement enabled";
      movementStatus.classList.remove("locked");
    }

    if (!state.has_image) {
      content.hidden = true;
      image.removeAttribute("src");
      darknessLayer.replaceChildren();
      darknessLayer.hidden = true;
      doorLayer.replaceChildren();
      doorLayer.hidden = true;
      gridLayer.hidden = true;
      areaLayer.replaceChildren();
      tokenLayer.replaceChildren();
      imageVersion = null;
      return;
    }
    if (state.image_version !== imageVersion) {
      image.src = `${state.image_url || scopedUrl("/current-image")}?v=${encodeURIComponent(state.image_version || 0)}`;
      imageVersion = state.image_version;
    } else {
      fitContent();
    }
  }

  async function load() {
    try {
      const response = await fetch(scopedUrl("/api/vtt-state"), { cache: "no-store" });
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      apply(await response.json());
    } catch (error) {
      console.error("VTT state load failed", error);
      movementStatus.textContent = "Connection problem";
      movementStatus.classList.add("locked");
    }
  }

  image.addEventListener("load", fitContent);
  image.addEventListener("error", () => setTimeout(load, 1000));
  window.addEventListener("resize", fitContent);
  coarsePointer.addEventListener?.("change", fitContent);

  load();
  const events = new EventSource(scopedUrl("/events"));
  events.addEventListener("update", load);
})();
