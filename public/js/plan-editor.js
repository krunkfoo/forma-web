/* plan-editor.js — interactive edit layer for plan-viewer canvas */
(function () {
  'use strict';

  var canvas = document.getElementById('planCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var state = {
    active: false,
    scanId: window.SCAN_ID || '',
    scanToken: window.SCAN_TOKEN || '',
    mode: 'indoor',       // 'indoor' or 'outdoor'
    data: null,           // working copy of room_snapshot (indoor)
    original: null,       // deep copy for cancel (indoor)
    selected: null,       // index into data.furniture (indoor)
    outdoorData: null,    // working copy of site_plan (outdoor)
    outdoorOriginal: null,// deep copy for cancel (outdoor)
    selectedFeature: null,// index into outdoorData.features (outdoor)
    dragging: false,
    dragOffX: 0,
    dragOffZ: 0,
    T: { scale: 40, tx: 0, ty: 0 },
  };

  // ── coordinate utils ────────────────────────────────────────
  function toCanvas(wx, wz) {
    return [wx * state.T.scale + state.T.tx, wz * state.T.scale + state.T.ty];
  }
  function toWorld(cx, cy) {
    return [(cx - state.T.tx) / state.T.scale, (cy - state.T.ty) / state.T.scale];
  }

  function fitTransform(pts) {
    var pad = 60;
    if (!pts || !pts.length) return;
    var xs = pts.map(function(p){return p[0];});
    var zs = pts.map(function(p){return p[1];});
    var minX=Math.min.apply(null,xs), maxX=Math.max.apply(null,xs);
    var minZ=Math.min.apply(null,zs), maxZ=Math.max.apply(null,zs);
    var rangeX=maxX-minX||1, rangeZ=maxZ-minZ||1;
    var scaleX=(canvas.width-pad*2)/rangeX, scaleZ=(canvas.height-pad*2)/rangeZ;
    var scale=Math.min(scaleX,scaleZ);
    state.T={scale:scale, tx:canvas.width/2-((minX+maxX)/2)*scale, ty:canvas.height/2-((minZ+maxZ)/2)*scale};
  }

  function gatherPoints() {
    var pts=[];
    var snap = state.data;
    (snap.walls||[]).forEach(function(w){
      var hw=w.width/2, ax=w.axX||0, az=w.axZ||0;
      pts.push([w.cx-ax*hw, w.cz-az*hw]);
      pts.push([w.cx+ax*hw, w.cz+az*hw]);
    });
    (snap.furniture||[]).forEach(function(f){ pts.push([f.cx,f.cz]); });
    return pts;
  }

  // ── hit tests ───────────────────────────────────────────────
  function furnitureAtPoint(cx, cy) {
    var snap = state.data;
    for (var i=(snap.furniture||[]).length-1; i>=0; i--) {
      var f = snap.furniture[i];
      var fw = (f.width||1)*state.T.scale/2;
      var fd = (f.depth||f.height||1)*state.T.scale/2;
      var cp = toCanvas(f.cx, f.cz);
      if (cx>=cp[0]-fw && cx<=cp[0]+fw && cy>=cp[1]-fd && cy<=cp[1]+fd) return i;
    }
    return -1;
  }

  function featureAtPoint(cx, cy) {
    var features = (state.outdoorData.features || []);
    for (var i = features.length-1; i >= 0; i--) {
      var f = features[i];
      var pos = f.position || f;
      var cp = toCanvas(pos.x || 0, pos.y || pos.z || 0);
      var r = Math.max(8, state.T.scale * 0.35) * 1.5;
      var dx = cx - cp[0], dy = cy - cp[1];
      if (dx*dx + dy*dy <= r*r) return i;
    }
    return -1;
  }

  // ── draw ────────────────────────────────────────────────────
  var C = {
    bg:'#0a140a', grid:'rgba(255,255,255,0.04)',
    wall:'#e8e8e8', door:'#4a9eff', window:'#33E566',
    furniture:'rgba(255,200,80,0.28)', furnitureBorder:'rgba(255,200,80,0.75)',
    furnitureText:'#ffc800', selected:'#ffd700', dimText:'rgba(240,240,240,0.55)'
  };

  function wallEndpoints(seg) {
    var hw=(seg.width||0)/2, ax=seg.axX||0, az=seg.axZ||0;
    return [[seg.cx-ax*hw,seg.cz-az*hw],[seg.cx+ax*hw,seg.cz+az*hw]];
  }

  function drawOutdoor() {
    var sp = state.outdoorData; if (!sp) return;

    // Boundary polygon
    var boundary = sp.boundary || [];
    if (boundary.length >= 2) {
      ctx.beginPath();
      boundary.forEach(function(p, i) {
        var cp = toCanvas(p.x || 0, p.y || p.z || 0);
        if (i === 0) ctx.moveTo(cp[0], cp[1]);
        else ctx.lineTo(cp[0], cp[1]);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(51,229,102,0.07)';
      ctx.fill();
      ctx.strokeStyle = '#33E566';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Walls
    (sp.walls || []).forEach(function(w) {
      var p1 = toCanvas(w.x1 || 0, w.y1 || w.z1 || 0);
      var p2 = toCanvas(w.x2 || 0, w.y2 || w.z2 || 0);
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
      ctx.strokeStyle = '#aaa'; ctx.lineWidth = Math.max(2, state.T.scale * 0.08);
      ctx.stroke();
    });

    // Features
    (sp.features || []).forEach(function(f, i) {
      var pos = f.position || f;
      var cp = toCanvas(pos.x || 0, pos.y || pos.z || 0);
      var r = Math.max(6, state.T.scale * 0.35);
      var type = (f.type || '').toLowerCase();
      var isSel = (i === state.selectedFeature);

      ctx.beginPath(); ctx.arc(cp[0], cp[1], r, 0, Math.PI * 2);

      if (type.indexOf('tree') !== -1 || type.indexOf('shrub') !== -1 || type.indexOf('plant') !== -1) {
        ctx.fillStyle = 'rgba(60,180,60,0.70)';
        ctx.strokeStyle = '#2ea84a';
      } else if (type.indexOf('hard') !== -1 || type.indexOf('pave') !== -1 || type.indexOf('path') !== -1) {
        ctx.fillStyle = 'rgba(160,140,100,0.50)';
        ctx.strokeStyle = '#a08c64';
      } else {
        ctx.fillStyle = 'rgba(180,180,180,0.45)';
        ctx.strokeStyle = '#999';
      }
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.fill(); ctx.stroke();

      // Selection ring
      if (isSel) {
        ctx.beginPath(); ctx.arc(cp[0], cp[1], r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Label
      var label = (f.label || f.type || '').toLowerCase();
      if (label && r > 10) {
        var fs = Math.min(11, Math.max(8, r * 0.7));
        ctx.fillStyle = isSel ? '#ffd700' : 'rgba(255,255,255,0.80)';
        ctx.font = 'bold ' + fs + 'px Inter,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label.slice(0, 10), cp[0], cp[1]);
      }
    });

    // Edit mode overlay
    ctx.fillStyle = 'rgba(255,215,0,0.65)';
    ctx.font = '12px Inter,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Edit mode — drag features to move, Delete to remove', 12, 12);
  }

  function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle=C.bg; ctx.fillRect(0,0,canvas.width,canvas.height);

    // Grid
    var cellPx=state.T.scale;
    if(cellPx>=18){
      ctx.save(); ctx.strokeStyle=C.grid; ctx.lineWidth=1;
      var ox=((state.T.tx%cellPx)+cellPx)%cellPx;
      var oy=((state.T.ty%cellPx)+cellPx)%cellPx;
      for(var x=ox;x<canvas.width;x+=cellPx){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}
      for(var y=oy;y<canvas.height;y+=cellPx){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}
      ctx.restore();
    }

    if (state.mode === 'outdoor') {
      drawOutdoor();
      return;
    }

    var snap=state.data; if(!snap) return;

    // Walls
    ctx.strokeStyle=C.wall; ctx.lineWidth=Math.max(3,state.T.scale*0.12);
    ctx.lineCap='round'; ctx.setLineDash([]);
    (snap.walls||[]).forEach(function(w){
      var eps=wallEndpoints(w);
      var p1=toCanvas(eps[0][0],eps[0][1]), p2=toCanvas(eps[1][0],eps[1][1]);
      ctx.beginPath(); ctx.moveTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); ctx.stroke();
    });

    // Openings
    ctx.lineWidth=2; ctx.setLineDash([6,4]);
    (snap.openings||[]).forEach(function(o){
      var isDoor=(o.kind||o.type||'').toLowerCase().indexOf('door')!==-1;
      ctx.strokeStyle=isDoor?C.door:C.window;
      var eps=wallEndpoints(o);
      var p1=toCanvas(eps[0][0],eps[0][1]), p2=toCanvas(eps[1][0],eps[1][1]);
      ctx.beginPath(); ctx.moveTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); ctx.stroke();
    });
    ctx.setLineDash([]);

    // Furniture
    (snap.furniture||[]).forEach(function(f,i){
      var fw=(f.width||1)*state.T.scale, fd=(f.depth||f.height||1)*state.T.scale;
      var cp=toCanvas(f.cx,f.cz);
      var isSel=(i===state.selected);

      ctx.save();
      ctx.translate(cp[0],cp[1]);
      ctx.fillStyle=isSel?'rgba(255,215,0,0.38)':C.furniture;
      ctx.strokeStyle=isSel?C.selected:C.furnitureBorder;
      ctx.lineWidth=isSel?2.5:1;
      ctx.beginPath(); ctx.rect(-fw/2,-fd/2,fw,fd);
      ctx.fill(); ctx.stroke();

      if(isSel){
        // corner handles
        ctx.fillStyle=C.selected;
        [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(function(c){
          ctx.beginPath(); ctx.arc(c[0]*fw/2,c[1]*fd/2,4,0,Math.PI*2); ctx.fill();
        });
      }

      var label=(f.label||f.type||'').toLowerCase();
      if(label){
        var fs=Math.min(12,Math.max(8,fw/6));
        ctx.fillStyle=C.furnitureText;
        ctx.font='bold '+fs+'px Inter,sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(label.slice(0,12),0,0);
      }
      ctx.restore();
    });

    // Edit mode overlay — instruction text
    ctx.fillStyle='rgba(255,215,0,0.65)';
    ctx.font='12px Inter,sans-serif';
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText('Edit mode — drag furniture to move, Delete to remove', 12, 12);
  }

  // ── pointer events ──────────────────────────────────────────
  function pointerPos(e) {
    var r=canvas.getBoundingClientRect();
    var src=e.touches?e.touches[0]:e;
    return [src.clientX-r.left, src.clientY-r.top];
  }

  function onDown(e) {
    if(!state.active) return;
    e.preventDefault();
    var pos=pointerPos(e);

    if (state.mode === 'outdoor') {
      var idx = featureAtPoint(pos[0], pos[1]);
      state.selectedFeature = idx >= 0 ? idx : null;
      if (idx >= 0) {
        var f = state.outdoorData.features[idx];
        var fpos = f.position || f;
        var wp = toWorld(pos[0], pos[1]);
        state.dragging = true;
        state.dragOffX = wp[0] - (fpos.x || 0);
        state.dragOffZ = wp[1] - (fpos.y || fpos.z || 0);
        canvas.style.cursor = 'grabbing';
      }
      draw();
      return;
    }

    var idx=furnitureAtPoint(pos[0],pos[1]);
    state.selected=idx>=0?idx:null;
    if(idx>=0){
      var f=state.data.furniture[idx];
      var wp=toWorld(pos[0],pos[1]);
      state.dragging=true;
      state.dragOffX=wp[0]-f.cx;
      state.dragOffZ=wp[1]-f.cz;
      canvas.style.cursor='grabbing';
    }
    draw();
  }

  function onMove(e) {
    if(!state.active) return;
    e.preventDefault();
    var pos=pointerPos(e);

    if (state.mode === 'outdoor') {
      if (state.dragging && state.selectedFeature != null) {
        var f = state.outdoorData.features[state.selectedFeature];
        var fpos = f.position || f;
        var wp = toWorld(pos[0], pos[1]);
        fpos.x = wp[0] - state.dragOffX;
        // write back to both .y and .z to cover both conventions
        var newVal = wp[1] - state.dragOffZ;
        if ('y' in fpos) fpos.y = newVal;
        if ('z' in fpos) fpos.z = newVal;
        if (!('y' in fpos) && !('z' in fpos)) fpos.y = newVal;
        draw();
      } else {
        var idx = featureAtPoint(pos[0], pos[1]);
        canvas.style.cursor = (idx >= 0) ? 'grab' : 'default';
      }
      return;
    }

    if(state.dragging && state.selected!=null){
      var wp=toWorld(pos[0],pos[1]);
      var f=state.data.furniture[state.selected];
      f.cx=wp[0]-state.dragOffX;
      f.cz=wp[1]-state.dragOffZ;
      draw();
    } else {
      var idx=furnitureAtPoint(pos[0],pos[1]);
      canvas.style.cursor=(idx>=0)?'grab':'default';
    }
  }

  function onUp(e) {
    if(!state.active) return;
    state.dragging=false;
    if (state.mode === 'outdoor') {
      canvas.style.cursor = state.selectedFeature != null ? 'grab' : 'default';
    } else {
      canvas.style.cursor=state.selected!=null?'grab':'default';
    }
  }

  function onKey(e) {
    if(!state.active) return;
    if(e.key==='Delete'||e.key==='Backspace'){
      if (state.mode === 'outdoor' && state.selectedFeature != null) {
        state.outdoorData.features.splice(state.selectedFeature, 1);
        state.selectedFeature = null;
        draw();
      } else if (state.mode === 'indoor' && state.selected != null) {
        state.data.furniture.splice(state.selected,1);
        state.selected=null;
        draw();
      }
    }
  }

  canvas.addEventListener('mousedown',onDown);
  canvas.addEventListener('mousemove',onMove);
  canvas.addEventListener('mouseup',onUp);
  canvas.addEventListener('mouseleave',onUp);
  canvas.addEventListener('touchstart',onDown,{passive:false});
  canvas.addEventListener('touchmove',onMove,{passive:false});
  canvas.addEventListener('touchend',onUp);
  window.addEventListener('keydown',onKey);

  // ── save ────────────────────────────────────────────────────
  function save() {
    var btn=document.getElementById('saveBtn');
    if(btn){btn.disabled=true; btn.textContent='Saving…';}
    var headers={'Content-Type':'application/json'};
    if(state.scanToken) headers['Authorization']='Bearer '+state.scanToken;
    var body = state.mode === 'outdoor'
      ? JSON.stringify({ site_plan: state.outdoorData })
      : JSON.stringify({ room_snapshot: state.data });
    fetch('/api/scans/'+state.scanId,{
      method:'PATCH',
      headers:headers,
      credentials:'include',
      body:body
    }).then(function(r){
      if(!r.ok) throw new Error(r.status);
      if(btn){btn.disabled=false; btn.textContent='Saved ✓';}
      setTimeout(function(){if(btn)btn.textContent='Save';},2000);
    }).catch(function(err){
      if(btn){btn.disabled=false; btn.textContent='Save';}
      alert('Save failed: '+err.message);
    });
  }

  function cancel() {
    if (state.mode === 'outdoor') {
      state.outdoorData = JSON.parse(JSON.stringify(state.outdoorOriginal));
      state.selectedFeature = null;
    } else {
      state.data=JSON.parse(JSON.stringify(state.original));
      state.selected=null;
    }
    draw();
    window.PlanEditor.deactivate();
  }

  // ── public API ──────────────────────────────────────────────
  window.PlanEditor = {
    activate: function(scanData) {
      state.mode = 'indoor';
      state.data=JSON.parse(JSON.stringify(scanData.room_snapshot||{}));
      state.original=JSON.parse(JSON.stringify(state.data));
      state.scanId=scanData.id||window.SCAN_ID||'';
      state.active=true;
      fitTransform(gatherPoints());
      draw();
    },
    activateOutdoor: function(scanData) {
      state.mode = 'outdoor';
      state.outdoorData = JSON.parse(JSON.stringify(scanData.site_plan || {}));
      state.outdoorOriginal = JSON.parse(JSON.stringify(state.outdoorData));
      state.scanId = scanData.id || window.SCAN_ID || '';
      state.active = true;
      state.selectedFeature = null;
      // fit transform from features and boundary
      var pts = [];
      (state.outdoorData.boundary||[]).forEach(function(p){ pts.push([p.x||0, p.y||p.z||0]); });
      (state.outdoorData.features||[]).forEach(function(f){
        var pos = f.position || f;
        pts.push([pos.x||0, pos.y||pos.z||0]);
      });
      fitTransform(pts);
      draw();
    },
    deactivate: function() {
      state.active=false;
      window.dispatchEvent(new CustomEvent('planEditorDeactivated'));
      window.dispatchEvent(new Event('resize'));
    },
    save: save,
    cancel: cancel,
  };
})();
