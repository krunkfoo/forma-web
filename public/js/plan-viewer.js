/* plan-viewer.js — canvas 2D floor plan / site plan renderer
 * Reads window.SCAN_DATA set by scan.ejs.
 * Handles both interior (room_snapshot) and outdoor (site_plan) scans.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('planCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var data = window.SCAN_DATA || {};

  /* ── Palette ─────────────────────────────────────────────── */
  var C = {
    bg:              '#0a140a',
    grid:            'rgba(255,255,255,0.04)',
    wall:            '#e8e8e8',
    door:            '#4a9eff',
    window:          '#33E566',
    furniture:       'rgba(255,200,80,0.28)',
    furnitureBorder: 'rgba(255,200,80,0.75)',
    furnitureText:   '#ffc800',
    boundary:        'rgba(51,229,102,0.14)',
    boundaryStroke:  '#33E566',
    wallLine:        '#aaaaaa',
    tree:            'rgba(55,175,55,0.75)',
    shrub:           'rgba(80,155,80,0.55)',
    hardscape:       'rgba(150,130,90,0.45)',
    hardscapeStroke: 'rgba(150,130,90,0.8)',
    dimText:         'rgba(240,240,240,0.55)',
    overlay:         '#f0f0f0',
    compassN:        '#33E566',
  };

  /* ── Transform state ─────────────────────────────────────── */
  var T = { scale: 40, tx: 0, ty: 0 };

  function toCanvas(wx, wz) {
    return [wx * T.scale + T.tx, wz * T.scale + T.ty];
  }

  /* Given an array of [x, z] pairs, compute a scale+translate that fits
     them in the canvas with `pad` pixels of margin on all sides. */
  function fitTransform(points, pad) {
    pad = pad || 60;
    if (!points || !points.length) {
      T = { scale: 40, tx: canvas.width / 2, ty: canvas.height / 2 };
      return;
    }
    var xs = points.map(function (p) { return p[0]; });
    var zs = points.map(function (p) { return p[1]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minZ = Math.min.apply(null, zs), maxZ = Math.max.apply(null, zs);
    var rangeX = maxX - minX || 1;
    var rangeZ = maxZ - minZ || 1;
    var scaleX = (canvas.width  - pad * 2) / rangeX;
    var scaleZ = (canvas.height - pad * 2) / rangeZ;
    var scale  = Math.min(scaleX, scaleZ);
    T = {
      scale: scale,
      tx: canvas.width  / 2 - ((minX + maxX) / 2) * scale,
      ty: canvas.height / 2 - ((minZ + maxZ) / 2) * scale,
    };
  }

  /* ── Wall geometry helpers ───────────────────────────────── */
  /* A wall/opening record has centre (cx, cz) and axis direction (axX, axZ).
     The segment runs ±width/2 from the centre along that axis. */
  function wallEndpoints(seg) {
    var hw  = (seg.width || 0) / 2;
    var axX = seg.axX || 0;
    var axZ = seg.axZ || 0;
    return [
      [seg.cx - axX * hw, seg.cz - axZ * hw],
      [seg.cx + axX * hw, seg.cz + axZ * hw],
    ];
  }

  /* ── Indoor renderer ─────────────────────────────────────── */
  function gatherIndoorPoints(snap) {
    var pts = [];
    (snap.walls || []).forEach(function (w) {
      wallEndpoints(w).forEach(function (p) { pts.push(p); });
    });
    (snap.furniture || []).forEach(function (f) {
      pts.push([f.cx, f.cz]);
    });
    return pts;
  }

  function drawIndoor(snap) {
    if (!snap) return;

    fitTransform(gatherIndoorPoints(snap));

    /* Walls — thick light lines */
    ctx.strokeStyle = C.wall;
    ctx.lineWidth   = Math.max(3, T.scale * 0.12);
    ctx.lineCap     = 'round';
    ctx.setLineDash([]);
    (snap.walls || []).forEach(function (w) {
      var eps = wallEndpoints(w);
      var p1  = toCanvas(eps[0][0], eps[0][1]);
      var p2  = toCanvas(eps[1][0], eps[1][1]);
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
    });

    /* Openings — thin dashed lines, blue=door, green=window */
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    (snap.openings || []).forEach(function (o) {
      var isDoor = (o.type || '').toLowerCase().indexOf('door') !== -1;
      ctx.strokeStyle = isDoor ? C.door : C.window;
      var eps = wallEndpoints(o);
      var p1  = toCanvas(eps[0][0], eps[0][1]);
      var p2  = toCanvas(eps[1][0], eps[1][1]);
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    /* Furniture — labelled rectangles */
    (snap.furniture || []).forEach(function (f) {
      var fw    = (f.width  || 1) * T.scale;
      var fd    = (f.depth  || f.height || 1) * T.scale;
      var angle = f.angle   || 0;
      var cp    = toCanvas(f.cx, f.cz);

      ctx.save();
      ctx.translate(cp[0], cp[1]);
      ctx.rotate(angle);
      ctx.fillStyle   = C.furniture;
      ctx.strokeStyle = C.furnitureBorder;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.rect(-fw / 2, -fd / 2, fw, fd);
      ctx.fill();
      ctx.stroke();

      var label = (f.label || f.type || '').toLowerCase();
      if (label) {
        var fs = Math.min(12, Math.max(8, fw / 6));
        ctx.fillStyle    = C.furnitureText;
        ctx.font         = 'bold ' + fs + 'px Inter, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label.slice(0, 12), 0, 0);
      }
      ctx.restore();
    });

    /* Room dimension label */
    var pts = gatherIndoorPoints(snap);
    if (pts.length >= 2) {
      var xs = pts.map(function (p) { return p[0]; });
      var zs = pts.map(function (p) { return p[1]; });
      var rW = (Math.max.apply(null, xs) - Math.min.apply(null, xs)).toFixed(1);
      var rD = (Math.max.apply(null, zs) - Math.min.apply(null, zs)).toFixed(1);
      ctx.fillStyle    = C.dimText;
      ctx.font         = '13px Inter, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(rW + ' m × ' + rD + ' m', canvas.width / 2, canvas.height - 38);
    }
  }

  /* ── Outdoor renderer ────────────────────────────────────── */
  function gatherOutdoorPoints(plan) {
    var pts = [];
    (plan.boundary || []).forEach(function (p) {
      pts.push([p.x, p.y != null ? p.y : (p.z || 0)]);
    });
    var wallSegs = plan.wall_lines || plan.wallLines || [];
    wallSegs.forEach(function (seg) {
      if (!seg) return;
      // {start:{x,y}, end:{x,y}} format from iOS
      if (seg.start && seg.end) {
        pts.push([seg.start.x, seg.start.y != null ? seg.start.y : (seg.start.z || 0)]);
        pts.push([seg.end.x,   seg.end.y   != null ? seg.end.y   : (seg.end.z   || 0)]);
      } else if (Array.isArray(seg)) {
        seg.forEach(function (p) {
          pts.push([p.x, p.y != null ? p.y : (p.z || 0)]);
        });
      }
    });
    (plan.features || []).forEach(function (f) {
      var pos = f.position || f;
      if (pos.x != null) pts.push([pos.x, pos.y != null ? pos.y : (pos.z || 0)]);
    });
    return pts;
  }

  function drawOutdoor(plan) {
    if (!plan) return;

    fitTransform(gatherOutdoorPoints(plan));

    /* Boundary polygon */
    var boundary = plan.boundary || [];
    if (boundary.length >= 2) {
      ctx.beginPath();
      boundary.forEach(function (p, i) {
        var cp = toCanvas(p.x, p.y != null ? p.y : (p.z || 0));
        if (i === 0) ctx.moveTo(cp[0], cp[1]);
        else         ctx.lineTo(cp[0], cp[1]);
      });
      ctx.closePath();
      ctx.fillStyle   = C.boundary;
      ctx.fill();
      ctx.strokeStyle = C.boundaryStroke;
      ctx.lineWidth   = 2.5;
      ctx.setLineDash([]);
      ctx.stroke();
    }

    /* Wall lines */
    ctx.strokeStyle = C.wallLine;
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    var wallSegs = plan.wall_lines || plan.wallLines || [];
    wallSegs.forEach(function (seg) {
      if (!seg) return;
      // {start:{x,y}, end:{x,y}} format from iOS
      if (seg.start && seg.end) {
        var p1 = toCanvas(seg.start.x, seg.start.y != null ? seg.start.y : (seg.start.z || 0));
        var p2 = toCanvas(seg.end.x,   seg.end.y   != null ? seg.end.y   : (seg.end.z   || 0));
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
      } else if (Array.isArray(seg) && seg.length >= 2) {
        ctx.beginPath();
        seg.forEach(function (p, i) {
          var cp = toCanvas(p.x, p.y != null ? p.y : (p.z || 0));
          if (i === 0) ctx.moveTo(cp[0], cp[1]);
          else         ctx.lineTo(cp[0], cp[1]);
        });
        ctx.stroke();
      }
    });

    /* Features */
    (plan.features || []).forEach(function (f) {
      var pos  = f.position || f;
      var fx   = pos.x != null ? pos.x : 0;
      var fy   = pos.y != null ? pos.y : (pos.z != null ? pos.z : 0);
      var cp   = toCanvas(fx, fy);
      var type = (f.type || f.label || '').toLowerCase();
      var r    = Math.max(6, T.scale * 0.35);

      if (type.indexOf('tree') !== -1) {
        ctx.beginPath();
        ctx.arc(cp[0], cp[1], r, 0, Math.PI * 2);
        ctx.fillStyle   = C.tree;
        ctx.strokeStyle = 'rgba(30,120,30,0.9)';
        ctx.lineWidth   = 1.5;
        ctx.fill();
        ctx.stroke();
      } else if (type.indexOf('shrub') !== -1 || type.indexOf('bush') !== -1) {
        ctx.beginPath();
        ctx.arc(cp[0], cp[1], r * 0.65, 0, Math.PI * 2);
        ctx.fillStyle = C.shrub;
        ctx.fill();
      } else if (
        type.indexOf('hard') !== -1 || type.indexOf('patio') !== -1 ||
        type.indexOf('path') !== -1  || type.indexOf('drive') !== -1
      ) {
        var hw = r * 1.2;
        ctx.beginPath();
        ctx.rect(cp[0] - hw, cp[1] - hw * 0.55, hw * 2, hw * 1.1);
        ctx.fillStyle   = C.hardscape;
        ctx.strokeStyle = C.hardscapeStroke;
        ctx.lineWidth   = 1;
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(cp[0], cp[1], 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fill();
      }

      var label = f.label || f.type || '';
      if (label) {
        ctx.fillStyle    = C.overlay;
        ctx.font         = '10px Inter, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label.slice(0, 16), cp[0], cp[1] + r + 3);
      }
    });

    /* Area label */
    if (data.area_m2) {
      ctx.fillStyle    = C.dimText;
      ctx.font         = '13px Inter, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(Math.round(data.area_m2) + ' m²', canvas.width / 2, canvas.height - 38);
    }
  }

  /* ── Overlays ─────────────────────────────────────────────── */
  function drawNorthArrow() {
    var x = canvas.width - 46;
    var y = 46;
    var r = 20;

    ctx.save();

    /* Circle background */
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(0,0,0,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.fill();
    ctx.stroke();

    /* North half (green) */
    ctx.beginPath();
    ctx.moveTo(x, y - r + 5);
    ctx.lineTo(x - 5, y + 5);
    ctx.lineTo(x, y + 1);
    ctx.closePath();
    ctx.fillStyle = C.compassN;
    ctx.fill();

    /* South half (dim) */
    ctx.beginPath();
    ctx.moveTo(x, y - r + 5);
    ctx.lineTo(x + 5, y + 5);
    ctx.lineTo(x, y + 1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fill();

    /* N label */
    ctx.fillStyle    = '#f0f0f0';
    ctx.font         = 'bold 10px Inter, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('N', x, y - r + 5);

    ctx.restore();
  }

  function niceMeters(v) {
    var candidates = [0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] >= v * 0.5) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  function drawScaleBar() {
    var targetPx  = 80;
    var realM     = targetPx / T.scale;
    var niceM     = niceMeters(realM);
    var barPx     = niceM * T.scale;
    var x = 20;
    var y = canvas.height - 20;
    var label = niceM >= 1 ? niceM + ' m' : (niceM * 100).toFixed(0) + ' cm';

    ctx.save();
    ctx.strokeStyle = C.overlay;
    ctx.fillStyle   = C.overlay;
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'square';

    ctx.beginPath();
    ctx.moveTo(x,         y - 5);
    ctx.lineTo(x,         y);
    ctx.lineTo(x + barPx, y);
    ctx.lineTo(x + barPx, y - 5);
    ctx.stroke();

    ctx.font         = '11px Inter, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x, y - 7);
    ctx.restore();
  }

  /* ── Background grid ─────────────────────────────────────── */
  function drawGrid() {
    var cellPx = T.scale; /* 1 m per cell */
    if (cellPx < 18) return; /* too dense — skip */
    ctx.save();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth   = 1;
    var ox = ((T.tx % cellPx) + cellPx) % cellPx;
    var oy = ((T.ty % cellPx) + cellPx) % cellPx;
    for (var x = ox; x < canvas.width;  x += cellPx) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (var y = oy; y < canvas.height; y += cellPx) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    ctx.restore();
  }

  /* ── Main draw ───────────────────────────────────────────── */
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();

    if (data.space_type === 'interior') {
      drawIndoor(data.room_snapshot);
    } else {
      drawOutdoor(data.site_plan);
    }

    drawNorthArrow();
    drawScaleBar();
  }

  /* ── Resize handling ─────────────────────────────────────── */
  function resize() {
    var wrap    = canvas.parentElement;
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    draw();
  }

  window.addEventListener('resize', resize);
  resize();
})();
