(() => {
  'use strict';

  const config = window.VERTICE_CONFIG || {};
  const authButton = document.getElementById('authBtn');
  const authScreen = document.getElementById('authScreen');
  const authForm = document.getElementById('authForm');
  const authFeedback = document.getElementById('authFeedback');
  const authSubmit = document.getElementById('authSubmit');
  const loginPhone = document.getElementById('loginPhone');
  const loginPassword = document.getElementById('loginPassword');
  const authTitle = document.getElementById('authTitle');
  const authLead = document.getElementById('authLead');
  const authHint = document.getElementById('authHint');
  const gpsButton = document.getElementById('gpsBtn');
  const driverGpsButton = document.getElementById('driverGpsBtn');
  const backendState = document.getElementById('backendState');
  const mapStamp = document.querySelector('.map-stamp');
  const mapSvg = document.querySelector('.map-svg');
  const mapWrap = document.querySelector('.map-wrap');
  const toast = document.getElementById('toast');

  let client = null;
  let currentUser = null;
  let driverProfile = null;
  let activeRole = null;
  let loadedUserId = null;
  let realtimeChannel = null;
  let watchId = null;
  let lastSentAt = 0;
  let memberships = [];
  let googleMap = null;
  let googleScriptStarted = false;
  let recoveryMode = false;
  const markers = new Map();
  const configured = Boolean(config.supabaseUrl && config.supabasePublishableKey && window.supabase && typeof window.supabase.createClient === 'function');

  function message(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 5200);
  }

  function setAuthFeedback(text, kind = '') {
    if (!authFeedback) return;
    authFeedback.textContent = text;
    authFeedback.className = `auth-feedback${kind ? ` ${kind}` : ''}`;
  }

  function setGpsButtonLabel(text) {
    [gpsButton, driverGpsButton].forEach(button => { if (button) button.textContent = text; });
  }

  function setState(text, live = false) {
    if (backendState) backendState.textContent = text;
    const driverCopy = document.getElementById('driverGpsCopy');
    if (driverCopy) driverCopy.textContent = text;
    const pill = document.querySelector('.live-pill');
    if (pill) {
      pill.innerHTML = `<i class="live-dot"></i> ${live ? 'GPS conectado' : 'GPS aguardando conexão'}`;
      pill.classList.toggle('is-live', live);
    }
  }

  function normalizePhone(value) {
    const trimmed = String(value || '').trim();
    const digits = trimmed.replace(/\D/g, '');
    let e164;
    if (trimmed.startsWith('+')) e164 = `+${digits}`;
    else if (digits.length === 10 || digits.length === 11) e164 = `+55${digits}`;
    else if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) e164 = `+${digits}`;
    else throw new Error('Informe o celular com DDD. Para números de fora do Brasil, use o formato internacional com + e código do país.');
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new Error('Número de celular inválido. Confira o DDD e o código do país.');
    return e164;
  }

  function phoneToTechnicalEmail(value) {
    const international = normalizePhone(value).slice(1);
    // Telefones brasileiros usam o DDD + número no e-mail, sem o prefixo internacional 55.
    const accountNumber = international.startsWith('55') ? international.slice(2) : international;
    return `${accountNumber}@sixstar.mobi`;
  }

  function missingSetup() {
    setState('Backend não configurado · GPS desligado');
    setAuthFeedback('O acesso por celular e senha será ativado após configurar a URL e a chave pública do Supabase.', 'error');
    if (gpsButton) gpsButton.disabled = false;
    if (authButton) authButton.textContent = 'Conectar backend';
    if (mapStamp) mapStamp.textContent = 'DEMONSTRAÇÃO · SEM GPS AO VIVO';
  }

  function loadGoogleMaps() {
    if (!config.googleMapsApiKey || googleScriptStarted || !mapWrap) return;
    googleScriptStarted = true;
    window.initVerticeGoogleMap = () => {
      const host = document.createElement('div');
      host.id = 'googleMap';
      host.setAttribute('aria-label', 'Mapa da frota com localizações recebidas do backend');
      mapWrap.insertBefore(host, mapWrap.firstChild);
      if (mapSvg) mapSvg.style.display = 'none';
      googleMap = new window.google.maps.Map(host, {
        center: { lat: -23.5505, lng: -46.6333 },
        zoom: 11,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        styles: [
          { elementType: 'geometry', stylers: [{ color: '#1f2022' }] },
          { elementType: 'labels.text.fill', stylers: [{ color: '#c4bdb3' }] },
          { elementType: 'labels.text.stroke', stylers: [{ color: '#171819' }] },
          { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#343638' }] },
          { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#131a20' }] },
          { featureType: 'poi', stylers: [{ visibility: 'off' }] }
        ]
      });
      if (mapStamp) mapStamp.textContent = 'GOOGLE MAPS · LOCALIZAÇÕES DO BACKEND';
      refreshLocations().catch(error => message(`Não foi possível atualizar as posições: ${error.message}`));
    };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.googleMapsApiKey)}&callback=initVerticeGoogleMap&loading=async`;
    script.async = true;
    script.onerror = () => message('Não foi possível carregar o Google Maps. Confira a chave e as restrições do domínio.');
    document.head.appendChild(script);
  }

  function placeMarker(location) {
    if (!googleMap || !window.google || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) return;
    const key = location.driver_id;
    let marker = markers.get(key);
    const position = { lat: Number(location.latitude), lng: Number(location.longitude) };
    const title = location.driver_name || `Motorista ${String(key).slice(0, 6)}`;
    if (marker) {
      marker.setPosition(position);
      marker.setTitle(title);
      return;
    }
    marker = new window.google.maps.Marker({
      map: googleMap,
      position,
      title,
      icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#d88a32', fillOpacity: 1, strokeColor: '#fff1dc', strokeWeight: 2 }
    });
    markers.set(key, marker);
  }

  function renderDriverRides(rides) {
    const host = document.getElementById('driverRides');
    if (!host || !driverProfile) return;
    host.replaceChildren();
    const assigned = rides.filter(ride => ride.driver_id === driverProfile.id && !['cancelled', 'completed', 'no_show'].includes(ride.status));
    if (!assigned.length) {
      const empty = document.createElement('div');
      empty.className = 'driver-empty';
      empty.textContent = 'Você não tem corridas futuras designadas.';
      host.appendChild(empty);
      return;
    }
    assigned.slice(0, 12).forEach(ride => {
      const date = new Date(ride.scheduled_at);
      const card = document.createElement('article'); card.className = 'driver-ride';
      const time = document.createElement('div'); time.className = 'driver-ride-time';
      time.textContent = `${date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })} · ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      const route = document.createElement('div'); route.className = 'driver-ride-route'; route.textContent = `${ride.pickup} → ${ride.destination}`;
      const passenger = document.createElement('div'); passenger.className = 'driver-ride-client'; passenger.textContent = `${ride.ride_code || ''} · ${ride.passenger_name} · ${ride.vehicle_label || ride.vehicle_category || 'Veículo'}`;
      if (ride.observations) { const notes = document.createElement('div'); notes.className = 'driver-ride-client'; notes.textContent = `Observações: ${ride.observations}`; card.appendChild(notes); }
      const mapLink = document.createElement('a'); mapLink.className = 'driver-ride-map';
      mapLink.href = ride.destination_url || `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ride.destination)}`;
      mapLink.target = '_blank'; mapLink.rel = 'noopener noreferrer'; mapLink.textContent = 'Abrir destino no Maps →';
      card.append(time, route, passenger, mapLink); host.appendChild(card);
    });
  }

  async function refreshRides() {
    if (!client || !memberships.length) return;
    const organizationIds = memberships.map(item => item.organization_id);
    const { data, error } = await client.from('vertice_rides')
      .select('id, ride_code, driver_id, passenger_name, pickup, pickup_url, destination, destination_url, observations, scheduled_at, vehicle_category, vehicle_label, status, vertice_drivers(display_name, vehicle_description)')
      .in('organization_id', organizationIds).order('scheduled_at', { ascending: true }).limit(150);
    if (error) throw error;
    const rides = data || [];
    renderDriverRides(rides);
    const table = document.getElementById('rideTableBody');
    const schedule = document.getElementById('scheduleList');
    if (!table || !schedule) return;
    table.replaceChildren(); schedule.replaceChildren();
    const today = new Date();
    const todayRides = rides.filter(ride => {
      const date = new Date(ride.scheduled_at);
      return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    });
    const statusInfo = {
      scheduled: ['Agendada', 'complete', 'pending'], confirmed: ['Agendada', 'complete', 'pending'],
      in_progress: ['Em andamento', '', 'active'], completed: ['Concluída', 'complete', 'complete'],
      no_show: ['No show', 'complete', 'complete'], cancelled: ['Cancelada', 'complete', 'complete']
    };
    rides.forEach(ride => {
      const [label, , tableClass] = statusInfo[ride.status] || ['Programada', 'complete', 'pending'];
      const date = new Date(ride.scheduled_at);
      const row = document.createElement('tr');
      row.dataset.status = ride.status === 'in_progress' ? 'active' : ['completed', 'cancelled'].includes(ride.status) ? 'complete' : 'pending';
      const cells = Array.from({ length: 5 }, () => document.createElement('td'));
      const passenger = document.createElement('span'); passenger.className = 'table-primary'; passenger.textContent = ride.passenger_name;
      const category = document.createElement('span'); category.className = 'table-sub'; category.textContent = `${ride.ride_code || 'Sem código'} · ${ride.vehicle_label || ride.vehicle_category || 'Veículo a designar'}`;
      cells[0].append(passenger, category);
      cells[1].textContent = `${ride.pickup} → ${ride.destination}`;
      cells[1].title = ride.observations || '';
      cells[2].textContent = ride.vertice_drivers?.display_name || (ride.vehicle_label ? ride.vehicle_label.split(' / ')[0] : 'A designar');
      cells[3].textContent = `${date.toLocaleDateString('pt-BR')} · ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      const status = document.createElement('span'); status.className = `status ${tableClass}`; status.textContent = label; cells[4].append(status);
      cells.forEach(cell => row.appendChild(cell)); table.appendChild(row);
    });
    todayRides.slice(0, 6).forEach(ride => {
      const date = new Date(ride.scheduled_at);
      const [label, rideClass] = statusInfo[ride.status] || ['Programada', 'complete'];
      const item = document.createElement('div'); item.className = 'ride';
      const rideTime = document.createElement('div'); rideTime.className = 'ride-time'; rideTime.textContent = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const info = document.createElement('div'); info.className = 'ride-info';
      const name = document.createElement('div'); name.className = 'ride-client'; name.textContent = ride.passenger_name;
      const route = document.createElement('div'); route.className = 'ride-route'; route.textContent = `${ride.pickup} → ${ride.destination}`;
      info.append(name, route);
      const badge = document.createElement('span'); badge.className = `ride-status ${ride.status === 'confirmed' ? '' : rideClass}`; badge.textContent = label;
      item.append(rideTime, info, badge); schedule.appendChild(item);
    });
    if (!todayRides.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'Não há embarques desta organização para hoje.'; schedule.appendChild(empty);
    }
    const noResults = document.getElementById('noResults');
    noResults.hidden = rides.length > 0;
    if (!rides.length) noResults.textContent = 'Ainda não há corridas cadastradas nesta organização.';
    const total = document.getElementById('totalRides');
    if (total) total.textContent = String(todayRides.length);
  }

  async function refreshDrivers() {
    if (!client || activeRole !== 'admin' || !memberships.length) return;
    const organizationId = memberships.find(item => item.role === 'owner' || item.role === 'dispatcher')?.organization_id;
    if (!organizationId) return;
    const { data, error } = await client.from('vertice_drivers')
      .select('id, display_name, vehicle_description').eq('organization_id', organizationId).eq('active', true)
      .order('display_name', { ascending: true });
    if (error) throw error;
    const select = document.getElementById('vehicle');
    if (!select) return;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Selecione motorista / veículo'; select.appendChild(placeholder);
    (data || []).forEach(driver => {
      const option = document.createElement('option'); option.value = driver.id;
      option.textContent = `${driver.display_name} / ${driver.vehicle_description || 'Veículo não informado'}`;
      option.dataset.driverName = driver.display_name; option.dataset.vehicle = driver.vehicle_description || '';
      select.appendChild(option);
    });
    if (!data?.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Cadastre um motorista para começar'; select.appendChild(option); }
  }

  async function refreshLocations() {
    if (!client || !memberships.length || activeRole === 'driver') return;
    const ids = memberships.filter(item => item.role === 'owner' || item.role === 'dispatcher').map(item => item.organization_id);
    if (!ids.length) return;
    const { data, error } = await client.from('vertice_driver_locations')
      .select('driver_id, organization_id, latitude, longitude, accuracy_m, captured_at, vertice_drivers(display_name)')
      .in('organization_id', ids).order('captured_at', { ascending: false }).limit(250);
    if (error) {
      setState('Backend conectado · aguardando autorização de leitura');
      return;
    }
    const newest = new Map();
    (data || []).forEach(row => {
      const ageMs = Date.now() - new Date(row.captured_at).getTime();
      if (ageMs <= 120000 && !newest.has(row.driver_id)) {
        row.driver_name = row.vertice_drivers && row.vertice_drivers.display_name;
        newest.set(row.driver_id, row); placeMarker(row);
      }
    });
    setState(newest.size ? `GPS ao vivo · ${newest.size} motorista(s) recente(s)` : 'Backend conectado · aguardando posições de motoristas', newest.size > 0);
  }

  function showAuthenticatedArea(role) {
    activeRole = role;
    document.body.classList.toggle('driver-mode', role === 'driver');
    document.body.classList.remove('auth-required');
    if (authScreen) authScreen.hidden = true;
    const driverView = document.getElementById('driverView');
    if (driverView) driverView.hidden = role !== 'driver';
    const driverName = document.getElementById('driverName');
    if (driverName && driverProfile) driverName.textContent = driverProfile.display_name;
    if (authButton) authButton.textContent = 'Sair da conta';
    if (authTitle) authTitle.textContent = 'Entre no Vértice';
    if (authLead) authLead.textContent = 'Use seu celular e senha. O sistema abrirá a área correspondente ao seu perfil.';
    if (role === 'driver') {
      setGpsButtonLabel(watchId === null ? 'Iniciar GPS do motorista' : 'Parar compartilhamento GPS');
      setState(`Motorista autenticado · ${driverProfile.display_name}`);
    } else {
      setGpsButtonLabel('GPS ativo nos motoristas vinculados');
      setState('Backend conectado · recebendo atualizações autorizadas');
    }
  }

  async function loadMemberships() {
    if (!currentUser || !client) return;
    if (loadedUserId === currentUser.id) return;
    loadedUserId = currentUser.id;
    const userId = currentUser.id;
    const { data, error } = await client.from('vertice_members').select('organization_id, role').eq('user_id', userId);
    if (error) throw error;
    memberships = data || [];
    const { data: drivers, error: driverError } = await client.from('vertice_drivers')
      .select('id, organization_id, display_name, active').eq('user_id', userId).eq('active', true).limit(2);
    if (driverError) throw driverError;
    driverProfile = (drivers || []).find(driver => memberships.some(member => member.organization_id === driver.organization_id && member.role === 'driver')) || null;
    const isAdmin = memberships.some(member => member.role === 'owner' || member.role === 'dispatcher');
    const isDriver = Boolean(driverProfile);
    if (isAdmin && isDriver) {
      await rejectAccess('Esta conta possui mais de um perfil ativo. Peça à administração que mantenha apenas o perfil correto para este acesso.');
      return;
    }
    const role = isAdmin ? 'admin' : isDriver ? 'driver' : null;
    if (!role) {
      await rejectAccess('Esta conta não está vinculada a um perfil ativo de administrador ou motorista. Peça à central que configure seu acesso.');
      return;
    }
    if (role === 'admin') memberships = memberships.filter(member => member.role === 'owner' || member.role === 'dispatcher');
    else memberships = memberships.filter(member => member.role === 'driver');
    const createDriverButton = document.getElementById('seeDrivers');
    if (createDriverButton) createDriverButton.hidden = role !== 'admin' || !memberships.some(member => member.role === 'owner');
    showAuthenticatedArea(role);
    setAuthFeedback('Acesso autorizado.', 'success');
    await refreshRides();
    if (role === 'admin') await refreshDrivers();
    await refreshLocations();
    subscribeToLocations();
  }

  async function rejectAccess(reason) {
    setAuthFeedback(reason, 'error');
    if (client) {
      const { error } = await client.auth.signOut();
      if (error) message(`Não foi possível encerrar a sessão sem perfil: ${error.message}`);
    }
    currentUser = null; loadedUserId = null; memberships = []; driverProfile = null; activeRole = null;
    document.body.classList.add('auth-required'); document.body.classList.remove('driver-mode');
    if (authScreen) authScreen.hidden = false;
  }

  function subscribeToLocations() {
    if (!client || !memberships.length || activeRole === 'driver') return;
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    const ids = new Set(memberships.map(item => item.organization_id));
    realtimeChannel = client.channel('vertice-live-fleet')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vertice_driver_locations' }, payload => {
        if (payload.new && ids.has(payload.new.organization_id)) {
          placeMarker(payload.new);
          refreshLocations().catch(error => message(`Erro ao atualizar GPS: ${error.message}`));
        }
      }).subscribe();
  }

  async function signInOrOut() {
    if (!configured || !client) {
      message('Backend ainda não conectado. Configure a URL e a chave pública do Supabase; nunca use service_role.');
      return;
    }
    if (!currentUser) return;
    if (watchId !== null) stopGps();
    const { error } = await client.auth.signOut();
    if (error) throw error;
    currentUser = null; loadedUserId = null; memberships = []; driverProfile = null; activeRole = null;
    if (realtimeChannel) { await client.removeChannel(realtimeChannel); realtimeChannel = null; }
    document.body.classList.remove('driver-mode'); document.body.classList.add('auth-required');
    if (authScreen) authScreen.hidden = false;
    const driverView = document.getElementById('driverView'); if (driverView) driverView.hidden = true;
    const driverRides = document.getElementById('driverRides'); if (driverRides) driverRides.replaceChildren();
    if (authButton) authButton.textContent = 'Conectar backend';
    setGpsButtonLabel('Iniciar GPS do motorista');
    setState('Backend conectado · sessão encerrada');
    setAuthFeedback('Sessão encerrada com segurança.');
    if (loginPassword) loginPassword.value = '';
    if (loginPhone) loginPhone.focus();
  }

  async function submitLogin(event) {
    event.preventDefault();
    if (!configured || !client) {
      setAuthFeedback('O acesso por celular e senha exige que o projeto Supabase esteja configurado e as migrações aplicadas.', 'error');
      return;
    }
    if (recoveryMode) {
      setAuthFeedback('A redefinição de senha por celular deve ser solicitada à central da operação.', 'error');
      return;
    }
    let email;
    try { email = phoneToTechnicalEmail(loginPhone.value); }
    catch (error) { setAuthFeedback(error.message, 'error'); loginPhone.focus(); return; }
    const password = loginPassword.value;
    if (!password) { setAuthFeedback('Informe sua senha.', 'error'); loginPassword.focus(); return; }
    if (authSubmit) authSubmit.disabled = true;
    const label = authSubmit && authSubmit.querySelector('span');
    if (label) label.textContent = 'Validando acesso…';
    setAuthFeedback('Verificando suas credenciais e permissões…');
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      currentUser = data.user;
      await loadMemberships();
      if (currentUser) message(activeRole === 'driver' ? 'Acesso do motorista autorizado.' : 'Acesso administrativo autorizado.');
    } catch (error) {
      currentUser = null; loadedUserId = null;
      setAuthFeedback('Não foi possível entrar. Confira o celular, a senha e o status da conta.', 'error');
      console.error('Falha na autenticação Vértice:', error);
    } finally {
      if (authSubmit) authSubmit.disabled = false;
      const buttonLabel = authSubmit && authSubmit.querySelector('span');
      if (buttonLabel) buttonLabel.textContent = 'Entrar com segurança';
    }
  }

  async function requestPasswordHelp() {
    setAuthFeedback('Para redefinir a senha, entre em contato com a administração da operação. A recuperação automática por SMS ainda não está configurada.', 'error');
  }

  function startGps() {
    if (!configured || !client) { message('GPS real exige o backend conectado e uma conta autorizada.'); return; }
    if (!currentUser || activeRole !== 'driver' || !driverProfile) { message('Entre com a conta autorizada do motorista antes de iniciar o GPS.'); return; }
    if (!navigator.geolocation) { message('Este navegador não oferece geolocalização. Abra o aplicativo em um dispositivo compatível com HTTPS.'); return; }
    watchId = navigator.geolocation.watchPosition(async position => {
      const now = Date.now();
      if (now - lastSentAt < 12000) return;
      lastSentAt = now;
      const { latitude, longitude, accuracy, heading, speed } = position.coords;
      const record = {
        organization_id: driverProfile.organization_id, driver_id: driverProfile.id,
        latitude, longitude, accuracy_m: accuracy, heading_deg: heading, speed_mps: speed,
        captured_at: new Date(position.timestamp).toISOString()
      };
      const { error } = await client.from('vertice_driver_locations').upsert(record, { onConflict: 'organization_id,driver_id' });
      if (error) { message(`A posição não foi enviada: ${error.message}`); return; }
      placeMarker({ ...record, driver_name: driverProfile.display_name });
      setState(`GPS ao vivo · precisão aproximada ${Math.round(accuracy || 0)} m`, true);
      if (mapStamp) mapStamp.textContent = 'LOCALIZAÇÃO DO MOTORISTA · TRANSMITIDA AO BACKEND';
    }, error => {
      watchId = null; setGpsButtonLabel('Iniciar GPS do motorista');
      const reason = error.code === 1 ? 'permissão negada' : error.code === 2 ? 'posição indisponível' : 'tempo esgotado';
      message(`Não foi possível obter o GPS: ${reason}. Confira a permissão do dispositivo e tente novamente.`);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    setGpsButtonLabel('Parar compartilhamento GPS');
    setState('GPS solicitado · aguardando posição do dispositivo');
  }

  function stopGps() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null; setGpsButtonLabel('Iniciar GPS do motorista'); setState('GPS parado pelo motorista');
    message('Compartilhamento de localização interrompido neste dispositivo.');
  }

  window.VerticeBackend = {
    refreshRides,
    getOrganizations() { return memberships.map(item => ({ organizationId: item.organization_id, role: item.role })); },
    async onboardDriver({ organizationId, userId, name, vehicle }) {
      if (!client || !currentUser || activeRole !== 'admin') throw new Error('Entre com uma conta administrativa antes de cadastrar motorista.');
      const allowed = memberships.some(item => item.organization_id === organizationId);
      if (!allowed) throw new Error('A conta atual não pode cadastrar motoristas nesta organização.');
      const { data, error } = await client.rpc('vertice_onboard_driver', {
        target_organization_id: organizationId, target_user_id: userId, driver_name: name, vehicle_info: vehicle || null
      });
      if (error) throw error;
      return { driverId: data };
    },
    async createUser({ name, phone, password, role, vehicle }) {
      if (!client || !currentUser || activeRole !== 'admin') throw new Error('Entre com uma conta administrativa antes de cadastrar um motorista.');
      if (role !== 'driver') throw new Error('Este formulário cadastra somente motoristas.');
      const membership = memberships.find(item => item.role === 'owner');
      if (!membership) throw new Error('Somente o responsável da operação pode cadastrar motoristas.');
      const { data, error } = await client.functions.invoke('vertice-create-user', {
        body: { full_name: name, phone, password, vehicle_description: vehicle || null }
      });
      const errorCode = data?.error;
      const messages = {
        unauthorized: 'Sua sessão expirou. Entre novamente.',
        forbidden: 'Somente o responsável da operação pode cadastrar motoristas.',
        invalid_phone: 'Informe um celular válido com DDD.',
        weak_password: 'A senha inicial precisa ter pelo menos 8 caracteres.',
        name_required: 'Informe o nome completo do motorista.',
        phone_already_registered: 'Este celular já está cadastrado.',
        create_user_failed: 'O Supabase não conseguiu criar a conta.',
        member_link_failed: 'A conta foi criada, mas o vínculo com a operação falhou. Avise o suporte antes de tentar novamente.',
        driver_profile_failed: 'A conta foi criada, mas o perfil do motorista falhou. Avise o suporte antes de tentar novamente.'
      };
      if (error || errorCode) throw new Error(messages[errorCode] || errorCode || error.message || 'Não foi possível criar o acesso.');
      await refreshDrivers();
      return { created: true, userId: data.user_id, role: data.role };
    },
    async assignRide({ rideId, driverId, organizationId }) {
      if (!client || !currentUser || activeRole !== 'admin') throw new Error('Entre com uma conta administrativa antes de designar uma corrida.');
      if (!memberships.some(item => item.organization_id === organizationId)) throw new Error('A conta atual não pode designar corridas nesta organização.');
      const { error } = await client.from('vertice_rides').update({ driver_id: driverId }).eq('id', rideId).eq('organization_id', organizationId);
      if (error) throw error;
      await refreshRides();
      return { assigned: true };
    },
    async transitionRide({ rideId, status }) {
      if (!client || !currentUser) throw new Error('Entre na operação antes de alterar o status da corrida.');
      const { data, error } = await client.rpc('vertice_transition_ride', { target_ride_id: rideId, next_status: status });
      if (error) throw error;
      await refreshRides();
      return { rideId: data };
    },
    async createRide({ code, passenger, origin, destination, originUrl, destinationUrl, date, time, driverId, driverName, vehicle, observations, status }) {
      if (!configured || !client || !currentUser) return { persisted: false };
      if (activeRole !== 'admin') throw new Error('Somente uma conta administrativa pode gravar corridas.');
      const membership = memberships.find(item => item.role === 'owner' || item.role === 'dispatcher');
      if (!membership) throw new Error('A conta atual não tem permissão para gravar corridas.');
      const allowedStatuses = ['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled'];
      if (!allowedStatuses.includes(status)) throw new Error('Selecione um status válido.');
      if (!driverId) throw new Error('Selecione um motorista cadastrado para a corrida.');
      const vehicleLabel = `${driverName || ''}${vehicle ? ` / ${vehicle}` : ''}`.trim();
      const { error } = await client.from('vertice_rides').insert({
        organization_id: membership.organization_id, ride_code: code, passenger_name: passenger, pickup: origin,
        pickup_url: originUrl || null, destination, destination_url: destinationUrl || null,
        scheduled_at: new Date(`${date}T${time}`).toISOString(), driver_id: driverId,
        vehicle_category: vehicle || 'executiva', vehicle_label: vehicleLabel,
        observations: observations || null, status, created_by: currentUser.id
      });
      if (error) throw error;
      return { persisted: true };
    }
  };

  if (authForm) authForm.addEventListener('submit', submitLogin);
  const forgotPassword = document.getElementById('forgotPassword');
  if (forgotPassword) forgotPassword.addEventListener('click', requestPasswordHelp);
  const passwordToggle = document.getElementById('passwordToggle');
  if (passwordToggle) passwordToggle.addEventListener('click', () => {
    const show = loginPassword.type === 'password';
    loginPassword.type = show ? 'text' : 'password';
    passwordToggle.textContent = show ? 'Ocultar' : 'Mostrar';
    passwordToggle.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  });

  if (!configured) {
    missingSetup();
  } else {
    client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    loadGoogleMaps();
    setAuthFeedback('Entre com o celular cadastrado e sua senha. O sistema identifica seu perfil automaticamente.');
    client.auth.getSession().then(({ data, error }) => {
      if (error) { setAuthFeedback(`Falha ao verificar a sessão: ${error.message}`, 'error'); return; }
      currentUser = data.session ? data.session.user : null;
      if (currentUser) loadMemberships().catch(err => setAuthFeedback(`Falha ao carregar permissões da conta: ${err.message}`, 'error'));
      else setState('Backend conectado · autenticação pendente');
    });
    client.auth.onAuthStateChange((event, session) => {
      currentUser = session ? session.user : null;
      if (event === 'PASSWORD_RECOVERY') {
        document.body.classList.add('auth-required');
        if (authScreen) authScreen.hidden = false;
        recoveryMode = true;
        if (authTitle) authTitle.textContent = 'Redefinição de senha';
        if (authLead) authLead.textContent = 'Solicite à administração um novo acesso para sua conta.';
        setAuthFeedback('A recuperação automática por telefone ainda não está configurada.', 'error');
        return;
      }
      if (currentUser) window.setTimeout(() => loadMemberships().catch(err => setAuthFeedback(`Falha ao carregar permissões da conta: ${err.message}`, 'error')), 0);
      else if (authScreen) {
        activeRole = null;
        document.body.classList.add('auth-required'); document.body.classList.remove('driver-mode'); authScreen.hidden = false;
      }
    });
  }

  if (authButton) authButton.addEventListener('click', () => signInOrOut().catch(err => message(`Não foi possível concluir a ação: ${err.message}`)));
  [gpsButton, driverGpsButton].forEach(button => { if (button) button.addEventListener('click', () => watchId === null ? startGps() : stopGps()); });
})();
