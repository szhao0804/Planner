/*
 * Platform layer for the installable app.
 * The app code was written against `window.claude.use('db' | 'assets' | 'downloads')`.
 * Here those are backed by Firebase: Firestore with an on-device cache (works offline,
 * syncs automatically when online), Google / email sign-in, normal file downloads,
 * and Google Drive backup (drive.file scope: the app only sees files it created).
 * All data lives under users/{uid}/... so each account only sees its own data.
 */
(function(){
  'use strict';

  var cfg = window.FIREBASE_CONFIG;
  var FB = window.FB;
  var PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var COLLECTIONS = ['schedule', 'todos', 'notes', 'diet'];
  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var DRIVE_FOLDER = '有氧引擎备份';

  var app = null, auth = null, fs = null, uid = null, currentUser = null;
  var dbResolve, assetsResolve;
  var dbPromise = new Promise(function(r){ dbResolve = r; });
  var assetsPromise = new Promise(function(r){ assetsResolve = r; });
  var imgCache = {}, imgPending = {}, pending = {};
  var syncError = '';
  var driveToken = null, driveTokenExp = 0;

  /* ---------------- service worker (offline + auto update) ---------------- */
  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); });
  }

  /* ---------------- helpers ---------------- */
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(text != null) e.textContent = text;
    return e;
  }
  function track(p){
    p.then(function(){ if(syncError){ syncError = ''; renderSync(); } })
     .catch(function(e){
       syncError = (e && e.code === 'permission-denied') ? '没有权限写入（检查 Firestore 规则）' : '有修改没能同步：' + ((e && e.code) || '未知错误');
       renderSync();
     });
    return p;
  }
  function errText(e){
    var c = e && e.code || '';
    return ({
      'auth/invalid-credential': '邮箱或密码不对。',
      'auth/invalid-login-credentials': '邮箱或密码不对。',
      'auth/wrong-password': '邮箱或密码不对。',
      'auth/user-not-found': '这个邮箱还没注册，点「注册新账号」。',
      'auth/email-already-in-use': '这个邮箱已经注册过了，直接登录。',
      'auth/invalid-email': '邮箱格式不对。',
      'auth/weak-password': '密码至少要 6 位。',
      'auth/missing-password': '请输入密码。',
      'auth/network-request-failed': '没有网络——这一步需要联网。',
      'auth/too-many-requests': '尝试太多次了，过一会儿再试。',
      'auth/unauthorized-domain': '这个网址还没加到 Firebase 的「已获授权的网域」（看设置指南）。',
      'auth/operation-not-allowed': '这个登录方式还没在 Firebase 里启用（看设置指南）。',
      'auth/popup-blocked': '弹出窗口被拦截了，再点一次试试。',
      'auth/popup-closed-by-user': '登录窗口被关掉了。',
      'auth/user-mismatch': '选的 Google 账号跟现在登录的不是同一个，请选回同一个 Gmail。',
      'auth/credential-already-in-use': '这个 Gmail 已经绑定了另一个账号。',
      'auth/provider-already-linked': '已经绑定过 Gmail 了。'
    })[c] || ('操作失败：' + (c || (e && e.message) || '未知错误'));
  }

  /* ---------------- db adapter (same shape the app already uses) ---------------- */
  function makeDb(){
    function col(name){ return FB.collection(fs, 'users', uid, name); }
    return Object.freeze({
      collection: function(name){
        var c = col(name);
        return {
          add: function(data){
            var ref = FB.doc(c);
            track(FB.setDoc(ref, data));          // applied to the local cache at once; syncs when online
            return Promise.resolve({id: ref.id});
          },
          doc: function(id){
            var ref = FB.doc(c, id);
            return {
              set: function(d){ track(FB.setDoc(ref, d)); return Promise.resolve(); },
              update: function(d){ track(FB.updateDoc(ref, d)); return Promise.resolve(); },
              delete: function(){ track(FB.deleteDoc(ref)); return Promise.resolve(); }
            };
          },
          onSnapshot: function(next, error){
            return FB.onSnapshot(c, function(snap){ next({docs: snap.docs}); }, error);
          }
        };
      }
    });
  }

  /* ---------------- images (compressed data inside Firestore) ---------------- */
  function blobToDataUrl(blob){
    return new Promise(function(resolve, reject){
      var fr = new FileReader();
      fr.onload = function(){ resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  function reencode(dataUrl, scale, quality){
    return new Promise(function(resolve, reject){
      var img = new Image();
      img.onload = function(){
        var w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }
  // A Firestore document holds at most 1 MiB, so keep each image comfortably below that
  function fitImage(blob){
    return blobToDataUrl(blob).then(function step(url, tries){
      tries = tries || 0;
      if(url.length <= 900000 || tries >= 6) return url;
      return reencode(url, 0.8, 0.72).then(function(u){ return step(u, tries + 1); });
    });
  }
  function dataUrlToBlob(u){
    var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(u || '');
    if(!m) return null;
    var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var arr = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], {type: m[1] || 'application/octet-stream'});
  }
  function imgCol(){ return FB.collection(fs, 'users', uid, 'images'); }
  function getImage(id){
    if(imgCache[id]) return Promise.resolve(imgCache[id]);
    if(imgPending[id]) return imgPending[id];
    imgPending[id] = dbPromise.then(function(){ return FB.getDoc(FB.doc(imgCol(), id)); }).then(function(s){
      var d = s.exists() ? s.data().data : '';
      if(d) imgCache[id] = d;
      delete imgPending[id];
      return d;
    }).catch(function(){ delete imgPending[id]; return ''; });
    return imgPending[id];
  }
  function makeAssets(){
    return Object.freeze({
      upload: function(blob){
        return fitImage(blob).then(function(url){
          var ref = FB.doc(imgCol());
          imgCache[ref.id] = url;
          track(FB.setDoc(ref, {data: url, bytes: url.length, createdAt: Date.now()}));
          return {id: ref.id, url: url, sizeBytes: url.length, contentType: 'image/jpeg'};
        });
      },
      delete: function(id){
        delete imgCache[id];
        track(FB.deleteDoc(FB.doc(imgCol(), id)));
        return Promise.resolve({deleted: true});
      },
      list: function(){
        return FB.getDocsFromCache(imgCol()).catch(function(){ return FB.getDocs(imgCol()); }).then(function(snap){
          var bytes = 0;
          snap.docs.forEach(function(d){ bytes += (d.data().bytes || 0); });
          return {assets: [], usage: {files: snap.docs.length, bytes: bytes, maxFiles: 0, maxBytes: 1024 * 1024 * 1024}};
        });
      }
    });
  }

  /* ---------------- Google account link + Drive backup ---------------- */
  function hasGoogle(){
    return !!(currentUser && (currentUser.providerData || []).some(function(p){ return p.providerId === 'google.com'; }));
  }
  // Must be called directly from a click (it may open a Google popup)
  function driveAuth(){
    if(driveToken && Date.now() < driveTokenExp) return Promise.resolve(driveToken);
    if(!currentUser) return Promise.reject({code: 'auth/no-user'});
    var provider = new FB.GoogleAuthProvider();
    provider.addScope(DRIVE_SCOPE);
    var linked = hasGoogle();
    if(linked){
      var g = currentUser.providerData.filter(function(p){ return p.providerId === 'google.com'; })[0];
      if(g && g.email) provider.setCustomParameters({login_hint: g.email});
    }else{
      provider.setCustomParameters({prompt: 'select_account'});
    }
    var p = linked ? FB.reauthenticateWithPopup(currentUser, provider) : FB.linkWithPopup(currentUser, provider);
    return p.then(function(res){
      var cred = FB.GoogleAuthProvider.credentialFromResult(res);
      if(!cred || !cred.accessToken) throw {code: 'drive/no-token'};
      driveToken = cred.accessToken;
      driveTokenExp = Date.now() + 50 * 60 * 1000;
      if(res.user) currentUser = res.user;
      renderAccount();
      return driveToken;
    });
  }
  function driveFetch(url, opts){
    opts = opts || {};
    opts.headers = Object.assign({Authorization: 'Bearer ' + driveToken}, opts.headers || {});
    return fetch(url, opts).then(function(r){
      if(r.status === 401){ driveToken = null; throw {code: 'drive/expired'}; }
      if(!r.ok) return r.text().then(function(t){ throw {code: 'drive/http-' + r.status, message: t}; });
      return r;
    });
  }
  function ensureFolder(){
    var q = encodeURIComponent("name='" + DRIVE_FOLDER + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    return driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&spaces=drive')
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(j.files && j.files[0]) return j.files[0].id;
        return driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder'})
        }).then(function(r){ return r.json(); }).then(function(j2){ return j2.id; });
      });
  }
  function multipartUpload(meta, blob){
    var boundary = 'bnd' + Math.random().toString(36).slice(2);
    var body = new Blob([
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + boundary + '\r\nContent-Type: application/zip\r\n\r\n', blob, '\r\n--' + boundary + '--'
    ]);
    return driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + boundary}, body: body
    }).then(function(r){ return r.json(); });
  }
  function driveUpload(blob, filename){
    if(!driveToken) return Promise.reject({code: 'drive/expired'});
    return ensureFolder().then(function(folderId){
      var meta = {name: filename, parents: [folderId], mimeType: 'application/zip'};
      return driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink', {
        method: 'POST',
        headers: {'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(blob.size)},
        body: JSON.stringify(meta)
      }).then(function(r){
        var loc = r.headers.get('Location');
        if(!loc){
          if(blob.size < 4.5 * 1024 * 1024) return multipartUpload(meta, blob);
          throw {code: 'drive/no-session'};
        }
        return fetch(loc, {method: 'PUT', headers: {'Content-Type': 'application/zip'}, body: blob}).then(function(r2){
          if(!r2.ok) throw {code: 'drive/upload-' + r2.status};
          return r2.json();
        });
      });
    });
  }
  function driveErrText(e){
    var c = e && e.code || '';
    if(/^auth\//.test(c)) return errText(e);
    if(c === 'drive/expired') return 'Google 授权过期了，再点一次。';
    if(c === 'drive/http-403') return 'Google Drive 拒绝了（可能要在 Google Cloud 启用 Drive API，看设置指南）。';
    if(c === 'drive/no-session') return '上传没能开始，请再试一次。';
    return '上传到 Google Drive 失败：' + (c || (e && e.message) || '未知错误');
  }

  // Public helpers the app uses
  window.PWA = {
    imgHtml: function(html){
      return String(html || '').replace(/src="\/_blob\/([A-Za-z0-9_-]{8,64})"/g, function(m, id){
        return 'src="' + (imgCache[id] || PLACEHOLDER) + '" data-img="' + id + '"';
      });
    },
    hydrate: function(root){
      if(!root) return;
      root.querySelectorAll('img[data-img]').forEach(function(img){
        var id = img.getAttribute('data-img');
        if(imgCache[id]){ if(img.getAttribute('src') !== imgCache[id]) img.setAttribute('src', imgCache[id]); return; }
        getImage(id).then(function(u){ if(u) img.setAttribute('src', u); else img.classList.add('img-missing'); });
      });
    },
    imageBlob: function(id){ return getImage(id).then(function(u){ return u ? dataUrlToBlob(u) : null; }); },
    driveAuth: driveAuth,
    driveUpload: driveUpload,
    driveErrText: driveErrText,
    hasGoogle: hasGoogle,
    signOut: signOutAll,
    user: function(){ return currentUser; }
  };

  /* ---------------- downloads ---------------- */
  var downloadsApi = Object.freeze({
    save: function(req){
      var data = req.data instanceof Blob ? req.data : new Blob([req.data]);
      var isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      try{
        var file = new File([data], req.filename, {type: data.type || 'application/octet-stream'});
        if(isTouch && navigator.canShare && navigator.canShare({files: [file]})){
          return navigator.share({files: [file], title: req.filename})
            .then(function(){ return {status: 'saved'}; })
            .catch(function(e){ throw {code: (e && e.name === 'AbortError') ? 'declined' : 'unavailable', message: String(e)}; });
        }
      }catch(e){}
      var url = URL.createObjectURL(data);
      var a = document.createElement('a');
      a.href = url; a.download = req.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
      return Promise.resolve({status: 'saved'});
    }
  });

  window.claude = Object.freeze({
    use: function(name){
      if(name === 'db') return dbPromise;
      if(name === 'assets') return assetsPromise;
      if(name === 'downloads') return Promise.resolve(downloadsApi);
      return Promise.resolve(null);
    }
  });

  /* ---------------- sync status chip ---------------- */
  var chip = null;
  function renderSync(){
    if(!chip) return;
    var state, label, title;
    if(stuck){ state = 'err fix'; label = '点我修复'; title = '这台设备上的本地数据卡住了。点一下会清掉本机缓存并重新从云端下载（云端数据不受影响）。'; }
    else if(syncError){ state = 'err'; label = '同步出错'; title = syncError; }
    else if(!navigator.onLine){ state = 'off'; label = '离线'; title = '没有网络：修改已经存在这台设备上，联网后会自动同步。'; }
    else if(Object.keys(pending).some(function(c){ return pending[c]; })){ state = 'busy'; label = '同步中'; title = '正在把修改上传到云端…'; }
    else { state = 'ok'; label = '已同步'; title = '所有修改都已经同步到云端。'; }
    chip.className = 'sync-chip ' + state;
    chip.querySelector('.sync-label').textContent = label;
    chip.title = title;
    chip.setAttribute('aria-label', '同步状态：' + label);
  }
  function mountChip(){
    var actions = document.querySelector('.top-actions');
    if(!actions || chip) return;
    chip = el('span', 'sync-chip');
    chip.setAttribute('role', 'status');
    chip.appendChild(el('span', 'sync-dot'));
    chip.appendChild(el('span', 'sync-label', ''));
    actions.insertBefore(chip, actions.firstChild);
    chip.addEventListener('click', function(){
      if(!stuck) return;
      chip.querySelector('.sync-label').textContent = '修复中…';
      resetLocalAndReload(false);
    });
    window.addEventListener('online', renderSync);
    window.addEventListener('offline', renderSync);
    renderSync();
  }
  // Watchdog: a healthy local database answers within a second or two, even offline.
  // If nothing arrives, the on-device copy is jammed; offer a one-tap repair.
  var gotSnapshot = false, stuck = false;
  function startWatchdog(){
    setTimeout(function(){
      if(!gotSnapshot && !signingOut){ stuck = true; renderSync(); }
    }, window.__watchdogMs || 12000);
  }
  function watchPending(){
    startWatchdog();
    COLLECTIONS.concat(['images', 'settings', 'dietFoods']).forEach(function(name){
      FB.onSnapshot(FB.collection(fs, 'users', uid, name), {includeMetadataChanges: true}, function(snap){
        gotSnapshot = true;
        if(stuck){ stuck = false; }
        pending[name] = snap.metadata.hasPendingWrites;
        renderSync();
      }, function(e){
        syncError = (e && e.code === 'permission-denied') ? '没有权限读取（检查 Firestore 规则）' : '同步中断：' + ((e && e.code) || '');
        renderSync();
      });
    });
  }

  /* ---------------- account line in the backup panel ---------------- */
  function renderAccount(){
    var box = document.getElementById('bpAccount');
    if(!box || !currentUser) return;
    box.innerHTML = '';
    var who = el('div', 'bp-acc-who');
    who.appendChild(el('span', '', '已登录：' + (currentUser.email || currentUser.displayName || '账号')));
    who.appendChild(el('span', 'bp-acc-tag' + (hasGoogle() ? ' ok' : ''), hasGoogle() ? 'Gmail 已绑定' : '未绑定 Gmail'));
    box.appendChild(who);
    var btns = el('div', 'bp-acc-btns');
    if(!hasGoogle()){
      var link = el('button', 'bp-acc-link', '绑定 Gmail');
      link.type = 'button';
      link.addEventListener('click', function(){
        driveAuth().then(function(){ renderAccount(); }).catch(function(e){
          var m = document.getElementById('bpMsg'); if(m){ m.textContent = errText(e); m.classList.add('err'); }
        });
      });
      btns.appendChild(link);
    }
    var out = el('button', 'bp-acc-out', '退出登录');
    out.type = 'button';
    var armed = false;
    out.addEventListener('click', function(){
      if(!armed){ armed = true; out.textContent = '确认退出？'; setTimeout(function(){ armed = false; out.textContent = '退出登录'; }, 3000); return; }
      signOutAll();
    });
    btns.appendChild(out);
    box.appendChild(btns);
  }
  // Never let one step hang the whole sequence
  function within(p, ms){
    return Promise.race([Promise.resolve(p).catch(function(){}), new Promise(function(r){ setTimeout(r, ms); })]);
  }
  // Delete this app's on-device Firestore databases (the cloud copy is untouched)
  function deleteLocalDbs(){
    var names = {};
    if(cfg && cfg.projectId){
      names['firestore/[DEFAULT]/' + cfg.projectId + '/main'] = 1;
    }
    var listP = (window.indexedDB && indexedDB.databases) ? indexedDB.databases().catch(function(){ return []; }) : Promise.resolve([]);
    return listP.then(function(list){
      (list || []).forEach(function(d){ if(d && d.name && /firestore/i.test(d.name)) names[d.name] = 1; });
      return Promise.all(Object.keys(names).map(function(n){
        return within(new Promise(function(res){
          try{
            var rq = indexedDB.deleteDatabase(n);
            rq.onsuccess = rq.onerror = rq.onblocked = function(){ res(); };
          }catch(e){ res(); }
        }), 3000);
      }));
    });
  }
  var signingOut = false;
  function resetLocalAndReload(doSignOut){
    signingOut = true;
    var p = (doSignOut && auth) ? within(FB.signOut(auth), 4000) : Promise.resolve();
    p.then(function(){ return fs ? within(FB.terminate(fs), 2500) : null; })
     .then(function(){ return fs ? within(FB.clearIndexedDbPersistence(fs), 2500) : null; })
     .then(deleteLocalDbs)
     .catch(function(){})
     .then(function(){ location.reload(); });
  }
  function signOutAll(){ resetLocalAndReload(true); }

  /* ---------------- login gate ---------------- */
  var gate = null, gateMsg = null;
  function setGateMsg(t, ok){ if(gateMsg){ gateMsg.textContent = t || ''; gateMsg.classList.toggle('ok', !!ok); } }
  function buildGate(){
    gate = el('div', 'auth-gate');
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-label', '登录');
    var card = el('div', 'auth-card');
    var logo = el('img', 'auth-logo');
    logo.src = 'icons/icon-192.png'; logo.alt = '';
    card.appendChild(logo);
    card.appendChild(el('h1', 'auth-title', '有氧引擎计划'));

    if(!cfg || !FB){
      card.appendChild(el('p', 'auth-sub', !FB ? '程序文件没有加载完整，请联网刷新一次。' : '还没连接云端：请按照设置指南，把 Firebase 配置粘贴到 config.js。'));
      gate.appendChild(card);
      document.body.appendChild(gate);
      return;
    }
    card.appendChild(el('p', 'auth-sub', '用 Gmail 登录后，课表、待办、笔记、饮食记录会存在这台设备上，离线也能用；有网时自动同步到你的其他设备。'));

    var g = el('button', 'auth-google');
    g.type = 'button';
    g.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.3 6.6 2.3 12s4.3 9.8 9.7 9.8c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z"/></svg><span>用 Google（Gmail）登录</span>';
    g.addEventListener('click', function(){
      setGateMsg('');
      var provider = new FB.GoogleAuthProvider();
      provider.addScope(DRIVE_SCOPE);
      provider.setCustomParameters({prompt: 'select_account'});
      FB.signInWithPopup(auth, provider).then(function(res){
        var cred = FB.GoogleAuthProvider.credentialFromResult(res);
        if(cred && cred.accessToken){ driveToken = cred.accessToken; driveTokenExp = Date.now() + 50 * 60 * 1000; }
      }).catch(function(e){
        var c = e && e.code;
        if(c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return;
        if(c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment' || c === 'auth/web-storage-unsupported'){
          return FB.signInWithRedirect(auth, provider).catch(function(e2){ setGateMsg(errText(e2)); });
        }
        setGateMsg(errText(e));
      });
    });
    card.appendChild(g);

    card.appendChild(el('div', 'auth-or', '或者用邮箱'));
    var form = el('form', 'auth-form');
    form.innerHTML = '<input type="email" name="email" autocomplete="email" placeholder="邮箱" required>' +
      '<input type="password" name="password" autocomplete="current-password" placeholder="密码（至少 6 位）" required minlength="6">' +
      '<div class="auth-row"><button type="submit" class="auth-primary">登录</button><button type="button" class="auth-secondary" data-act="signup">注册新账号</button></div>' +
      '<button type="button" class="auth-link" data-act="reset">忘记密码？</button>';
    form.addEventListener('submit', function(e){
      e.preventDefault();
      setGateMsg('登录中…', true);
      FB.signInWithEmailAndPassword(auth, form.email.value.trim(), form.password.value)
        .catch(function(err){ setGateMsg(errText(err)); });
    });
    form.querySelector('[data-act="signup"]').addEventListener('click', function(){
      if(!form.email.value.trim() || form.password.value.length < 6){ setGateMsg('先填好邮箱和至少 6 位的密码。'); return; }
      setGateMsg('注册中…', true);
      FB.createUserWithEmailAndPassword(auth, form.email.value.trim(), form.password.value)
        .catch(function(err){ setGateMsg(errText(err)); });
    });
    form.querySelector('[data-act="reset"]').addEventListener('click', function(){
      if(!form.email.value.trim()){ setGateMsg('先在上面填你的邮箱。'); return; }
      FB.sendPasswordResetEmail(auth, form.email.value.trim())
        .then(function(){ setGateMsg('重设密码的邮件已经发出，去邮箱看看。', true); })
        .catch(function(err){ setGateMsg(errText(err)); });
    });
    card.appendChild(form);
    gateMsg = el('div', 'auth-msg');
    gateMsg.setAttribute('role', 'alert');
    card.appendChild(gateMsg);
    card.appendChild(el('p', 'auth-note', '用邮箱登录的话，之后可以在「备份」里再绑定 Gmail。'));
    gate.appendChild(card);
    document.body.appendChild(gate);
  }
  function showGate(show){
    if(!gate) buildGate();
    gate.hidden = !show;
    document.body.classList.toggle('auth-locked', !!show);
  }

  /* ---------------- start ---------------- */
  function start(){
    mountChip();
    if(!cfg || !FB){ showGate(true); return; }
    try{
      app = FB.initializeApp(cfg);
      auth = FB.initializeAuth(app, {
        persistence: [FB.indexedDBLocalPersistence, FB.browserLocalPersistence],
        popupRedirectResolver: FB.browserPopupRedirectResolver
      });
      fs = FB.initializeFirestore(app, {localCache: FB.persistentLocalCache({tabManager: FB.persistentMultipleTabManager()})});
    }catch(e){
      showGate(true);
      setGateMsg('Firebase 配置有问题：' + (e && e.message || e));
      return;
    }
    FB.getRedirectResult(auth).catch(function(e){ showGate(true); setGateMsg(errText(e)); });
    var resolved = false;
    FB.onAuthStateChanged(auth, function(user){
      if(user){
        if(resolved && uid !== user.uid){ location.reload(); return; }
        currentUser = user;
        uid = user.uid;
        showGate(false);
        if(!resolved){
          resolved = true;
          dbResolve(makeDb());
          assetsResolve(makeAssets());
          watchPending();
        }
        renderAccount();
      }else{
        if(resolved){ if(!signingOut) location.reload(); return; }   // signOutAll reloads itself once local data is cleared
        showGate(true);
      }
    });
    document.addEventListener('click', function(e){ if(e.target.closest && e.target.closest('#backupBtn')) setTimeout(renderAccount, 0); });
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
