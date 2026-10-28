const menuToggle = document.querySelector('.menu-toggle');
const primaryNav = document.querySelector('.primary-nav');
const dialog = document.querySelector('#portal-dialog');
const dialogContent = document.querySelector('#dialog-content');
const toast = document.querySelector('#portal-toast');
const i18n = window.SonicI18n;
let razorpayScriptPromise;

const session = {
  user: null,
  patient: null,
  appointments: [],
  doctors: [],
  doctor: null,
  doctorProfile: null,
  doctorAppointments: [],
  doctorCredentialStatus: '',
  doctorAvailability: []
};

class ApiRequestError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function apiRequest(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (['POST', 'PATCH', 'DELETE'].includes(method)) {
    const csrfResponse = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
    const csrfPayload = await csrfResponse.json();
    if (!csrfResponse.ok || !csrfPayload.csrfToken) {
      throw new ApiRequestError('Could not establish a secure request token.', csrfResponse.status, 'CSRF_UNAVAILABLE');
    }
    headers['x-csrf-token'] = csrfPayload.csrfToken;
  }
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiRequestError('The server returned an invalid response.', response.status, 'INVALID_RESPONSE');
    }
  }
  if (!response.ok) {
    throw new ApiRequestError(
      payload?.error?.message || 'The request could not be completed.',
      response.status,
      payload?.error?.code || 'REQUEST_FAILED'
    );
  }
  return payload;
}

function showApiError(error) {
  showToast(error instanceof Error ? error.message : 'The request could not be completed.');
}

if (menuToggle && primaryNav) {
  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    menuToggle.setAttribute('aria-label', i18n.translate(isOpen ? 'Open navigation menu' : 'Close navigation menu'));
    primaryNav.classList.toggle('is-open', !isOpen);
  });

  primaryNav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', i18n.translate('Open navigation menu'));
      primaryNav.classList.remove('is-open');
    });
  });
}

document.querySelector('#year').textContent = new Date().getFullYear();

function showToast(message) {
  toast.textContent = i18n.translate(message);
  toast.classList.add('is-visible');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function openDialog(content) {
  dialogContent.replaceChildren(content);
  dialog.showModal();
}

function elementFromHtml(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content;
}

function requireSignIn() {
  if (session.user?.role === 'Patient') return true;
  showAuthDialog('login');
  return false;
}

function showAuthDialog(mode, preferredRole = 'Patient') {
  const registering = mode === 'register';
  const roleOptions = `<label>Account type<select name="role" required><option value="Patient"${preferredRole === 'Patient' ? ' selected' : ''}>Patient</option><option value="Doctor"${preferredRole === 'Doctor' ? ' selected' : ''}>Doctor</option></select></label>`;
  const form = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">SECURE ACCOUNT</span>
      <h2 id="dialog-title">${registering ? 'Create your account' : 'Sign in to your account'}</h2>
      <p>${registering ? 'Your account will be stored securely.' : 'Use your registered email and password.'}</p>
    </div>
    <form class="dialog-form" id="auth-form">
      ${registering ? `${roleOptions}<label>Full name<input name="fullName" autocomplete="name" required minlength="2" maxlength="120" placeholder="Your name"></label>` : ''}
      <label>Email address<input name="email" type="email" autocomplete="email" required maxlength="120" placeholder="you@example.com"></label>
      <label>Password<input name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" required minlength="12" maxlength="128"></label>
      ${registering && preferredRole === 'Doctor' ? '<p class="dialog-disclaimer">Doctor accounts remain pending until an administrator verifies the required credentials.</p>' : ''}
      <p class="form-message" id="auth-message" role="status"></p>
      <button class="button button-primary" type="submit">Continue</button>
    </form>
    <button type="button" class="dialog-switch" data-auth-switch="${registering ? 'login' : 'register'}">${registering ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
  `);
  openDialog(form);

  document.querySelector('[data-auth-switch]').addEventListener('click', () => {
    const role = registering ? document.querySelector('#auth-form [name=role]').value : preferredRole;
    showAuthDialog(registering ? 'login' : 'register', role);
  });
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email')).trim();
    const role = registering ? String(data.get('role')) : undefined;
    const submit = event.currentTarget.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const result = registering
        ? await apiRequest(`auth/register/${role.toLowerCase()}`, {
          method: 'POST',
          body: { fullName: String(data.get('fullName')).trim(), email, password: String(data.get('password')) }
        })
        : await apiRequest('auth/login', {
          method: 'POST',
          body: { email, password: String(data.get('password')) }
        });
      await openAuthenticatedAccount(result.user);
      dialog.close();
      showToast(result.user.role === 'Doctor' && registering
        ? 'Account created. Doctor profile is pending credential verification.'
        : 'You are signed in.');
    } catch (error) {
      document.querySelector('#auth-message').textContent =
        i18n.translate(error instanceof Error ? error.message : 'The request could not be completed.');
    } finally {
      submit.disabled = false;
    }
  });
}

async function openAuthenticatedAccount(user) {
  session.user = user;
  session.appointments = [];
  session.doctorAppointments = [];
  if (user.role === 'Patient') {
    const [profile, language] = await Promise.all([
      apiRequest('patients/me'),
      apiRequest('profile/language')
    ]);
    session.patient = {
      name: profile.fullName,
      email: profile.email,
      phone: profile.phone || '',
      preferredLanguage: language.language
    };
    session.doctor = null;
    session.doctorProfile = null;
    i18n.setLanguage(language.language);
    document.querySelector('#doctor-login').hidden = true;
    document.querySelector('#patient-portal').hidden = false;
    updateAccount();
    updateProfileForm();
    selectPanel('doctors');
    await loadAppointments();
    return;
  }
  if (user.role === 'Doctor') {
    const [profile, language] = await Promise.all([
      apiRequest('doctors/me'),
      apiRequest('profile/language')
    ]);
    session.patient = null;
    session.doctorProfile = profile;
    session.doctor = { name: profile?.fullName || user.email, email: user.email };
    session.doctorCredentialStatus = profile?.verificationStatus || 'Pending';
    i18n.setLanguage(language.language);
    document.querySelector('#patient-portal').hidden = true;
    document.querySelector('#doctor-login').hidden = false;
    updateAccount();
    updateDoctorAccount();
    updateDoctorProfileForm();
    selectDoctorPanel('overview');
    return;
  }
  throw new Error('This account role does not have a portal interface.');
}

function updateDoctorAccount() {
  const account = document.querySelector('#doctor-account');
  const name = document.createElement('strong');
  name.textContent = session.doctor?.name || 'Doctor workspace';
  const email = document.createElement('small');
  email.textContent = session.doctor?.email || 'Not signed in';
  const details = document.createElement('span');
  details.append(name, email);
  const avatar = document.createElement('span');
  avatar.className = 'account-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = session.doctor?.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'D';
  account.replaceChildren(avatar, details);
  const greeting = document.querySelector('#doctor-overview-heading');
  greeting.textContent = i18n.translate('Good day, {name}', { name: session.doctor?.name || 'doctor' });
}

function updateDoctorProfileForm() {
  const form = document.querySelector('#doctor-profile-form');
  if (!form || !session.doctorProfile) return;
  form.elements.name.value = session.doctorProfile.fullName || '';
  form.elements.specialty.value = session.doctorProfile.specialization || '';
  form.elements.fee.value = session.doctorProfile.consultationFee ?? '';
  form.elements.bio.value = session.doctorProfile.biography || '';
}

function formatRupees(amount) {
  return `₹${amount.toLocaleString('en-IN')}`;
}

function updateDoctorEarnings(earnings) {
  const count = Number(earnings?.paidPayments || 0);
  const gross = formatRupees(Number(earnings?.grossPaise || 0) / 100);
  const commission = formatRupees(Number(earnings?.commissionPaise || 0) / 100);
  const net = formatRupees(Number(earnings?.earningsPaise || 0) / 100);
  document.querySelector('#doctor-monthly-consultations').textContent = String(count);
  document.querySelector('#doctor-report-consultations').textContent = String(count);
  document.querySelector('#doctor-report-paid-payments').textContent = String(count);
  document.querySelector('#doctor-net-earnings').textContent = net;
  document.querySelector('#doctor-gross-fees').textContent = gross;
  document.querySelector('#doctor-report-gross').textContent = gross;
  document.querySelector('#doctor-platform-adjustments').textContent = commission;
  document.querySelector('#doctor-report-adjustments').textContent = commission;
  document.querySelector('#doctor-net-amount').textContent = net;
  document.querySelector('#doctor-report-net-earnings').textContent = net;
}

function selectDoctorPanel(panelName) {
  document.querySelectorAll('[data-doctor-panel]').forEach((tab) => {
    const isActive = tab.dataset.doctorPanel === panelName;
    tab.classList.toggle('is-active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.querySelectorAll('[id^="doctor-panel-"]').forEach((panel) => {
    panel.hidden = panel.id !== `doctor-panel-${panelName}`;
  });
  if (panelName === 'appointments' || panelName === 'overview') void loadDoctorAppointments().catch(showApiError);
  if (panelName === 'availability') void loadDoctorAvailability().catch(showApiError);
  if (panelName === 'credentials') void loadDoctorCredentials().catch(showApiError);
  if (panelName === 'consultation') {
    void renderDoctorHistory();
    void loadPrescriptions().catch(showApiError);
  }
  if (panelName === 'overview' || panelName === 'reports') void loadDoctorEarnings().catch(showApiError);
}

async function loadDoctorAppointments() {
  if (session.user?.role !== 'Doctor') return;
  session.doctorAppointments = await apiRequest('doctors/appointments');
  document.querySelector('#doctor-upcoming-count').textContent = String(
    session.doctorAppointments.filter((appointment) =>
      Date.parse(appointment.startAt) > Date.now() &&
      ['PendingPayment', 'Confirmed'].includes(appointment.status)
    ).length
  );
  renderDoctorAppointments();
  updateClinicalAppointments();
}

async function loadDoctorEarnings() {
  if (session.user?.role !== 'Doctor') return;
  updateDoctorEarnings(await apiRequest('doctors/earnings'));
}

async function loadDoctorAvailability() {
  if (session.user?.role !== 'Doctor' || !session.user.userId) return;
  const from = new Date();
  const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  session.doctorAvailability = await apiRequest(
    `doctors/${encodeURIComponent(session.user.userId)}/availability?${params}`
  );
  const list = document.querySelector('#doctor-availability-list');
  list.innerHTML = session.doctorAvailability.map((slot) => `
    <article class="appointment-card">
      <div class="appointment-date"><strong>${formatAppointmentDate(slot.startAt)}</strong><small>Until ${formatAppointmentDate(slot.endAt)}</small></div>
      <div class="appointment-actions"><button type="button" class="text-action" data-availability-remove="${escapeHtml(slot.availabilityId)}">Remove</button></div>
    </article>
  `).join('') || '<p class="empty-state">No available appointment times in the next 30 days.</p>';
}

async function loadDoctorCredentials() {
  if (session.user?.role !== 'Doctor') return;
  const credentials = await apiRequest('doctors/credentials');
  const status = session.doctorProfile?.verificationStatus || 'Pending';
  document.querySelector('#credential-status').textContent =
    `${i18n.translate(status)}${credentials.length ? ` · ${credentials.map((credential) => i18n.translate(credential.status)).join(', ')}` : ''}`;
  session.doctorCredentialStatus = status;
}

function renderDoctorAppointments() {
  const pending = session.doctorAppointments.filter((appointment) => appointment.status === 'PendingPayment').length;
  document.querySelector('#pending-count').textContent = String(pending);
  const renderList = (appointments) => appointments.map((appointment) => `
    <article class="appointment-card doctor-appointment-card">
      <div class="appointment-date"><span>${escapeHtml(i18n.translate(appointment.status === 'PendingPayment' ? 'Pending payment' : appointment.status))}</span><strong>${formatAppointmentDate(appointment.startAt)}</strong><small>Reference ${escapeHtml(appointment.appointmentId)}</small></div>
      <div class="appointment-doctor"><strong>${escapeHtml(appointment.patientName || 'Patient details unavailable')}</strong><span>${escapeHtml(i18n.translate(appointment.paymentStatus))}</span><small>${formatRupees(Number(appointment.feeAmount))}</small></div>
      <div class="appointment-actions">
        ${appointment.status === 'PendingPayment' ? `<button type="button" class="text-action" data-doctor-appointment="reject" data-appointment-id="${appointment.appointmentId}">Reject request</button>` : ''}
        ${appointment.status === 'Confirmed' && appointment.paymentStatus === 'Paid' && Date.parse(appointment.endAt) <= Date.now() ? `<button type="button" class="button button-outline button-small" data-doctor-appointment="complete" data-appointment-id="${appointment.appointmentId}">Mark completed</button>` : ''}
      </div>
    </article>
  `).join('');
  document.querySelector('#doctor-appointment-list').innerHTML = renderList(session.doctorAppointments) || '<p class="empty-state">No appointments are currently assigned to this account.</p>';
  document.querySelector('#doctor-upcoming-list').innerHTML = renderList(session.doctorAppointments.filter((appointment) =>
    Date.parse(appointment.startAt) > Date.now() &&
    ['PendingPayment', 'Confirmed'].includes(appointment.status)
  ).slice(0, 2)) || '<p class="empty-state">No upcoming appointments.</p>';
}

async function renderDoctorHistory() {
  const history = document.querySelector('#doctor-history-content');
  const appointmentId = document.querySelector('#clinical-appointment').value;
  if (session.user?.role !== 'Doctor') {
    history.innerHTML = '<p class="empty-state">Doctor workspace access is required.</p>';
    return;
  }
  if (!appointmentId) {
    history.innerHTML = '<p class="empty-state">Select an assigned, paid appointment to view authorized patient details.</p>';
    return;
  }
  try {
    const patient = await apiRequest(`doctors/appointments/${encodeURIComponent(appointmentId)}/patient`);
    history.textContent = `Authorized patient: ${patient.fullName}`;
  } catch (error) {
    history.textContent = error instanceof Error ? error.message : 'Patient details could not be loaded.';
  }
}

function updateClinicalAppointments() {
  const select = document.querySelector('#clinical-appointment');
  if (!select) return;
  const eligible = session.doctorAppointments.filter((appointment) =>
    appointment.paymentStatus === 'Paid' && ['Confirmed', 'Completed'].includes(appointment.status)
  );
  select.innerHTML = '<option value="">Select an assigned paid appointment</option>' + eligible.map((appointment) => `
    <option value="${escapeHtml(appointment.appointmentId)}">${escapeHtml(appointment.patientName || 'Authorized patient')} · ${formatAppointmentDate(appointment.startAt)}</option>
  `).join('');
}

async function loadPrescriptions() {
  if (session.user?.role !== 'Doctor') return;
  const prescriptions = await apiRequest('prescriptions');
  const container = document.querySelector('#clinical-items');
  container.innerHTML = prescriptions.map((prescription) => `
    <article class="clinical-item">
      <strong>${formatAppointmentDate(prescription.createdAt)}</strong>
      <p><b>Prescription:</b> ${escapeHtml(prescription.itemName)}</p>
      <p><b>Dosage:</b> ${escapeHtml(prescription.dosage || '—')}</p>
      <p><b>Frequency:</b> ${escapeHtml(prescription.frequency || '—')}</p>
      <p><b>Duration:</b> ${escapeHtml(prescription.duration || '—')}</p>
    </article>
  `).join('') || '<p class="empty-state">No prescriptions are associated with your account.</p>';
}

function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}

function updateAccount() {
  const account = document.querySelector('#portal-account');
  const signIn = document.querySelector('.portal-sign-in');
  const signOut = document.querySelector('.portal-logout');
  if (!session.patient) {
    account.innerHTML = '<span class="account-avatar" aria-hidden="true">P</span><span><strong>Guest patient</strong><small>Sign in to use your portal</small></span>';
    signIn.hidden = false;
    signOut.hidden = true;
    return;
  }
  const initials = session.patient.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const name = document.createElement('strong');
  name.textContent = session.patient.name;
  const email = document.createElement('small');
  email.textContent = session.patient.email;
  const details = document.createElement('span');
  details.append(name, email);
  const avatar = document.createElement('span');
  avatar.className = 'account-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initials || 'P';
  account.replaceChildren(avatar, details);
  signIn.hidden = true;
  signOut.hidden = false;
}

function updateProfileForm() {
  const form = document.querySelector('#profile-form');
  if (!form) return;
  form.elements.name.value = session.patient?.name || '';
  form.elements.email.value = session.patient?.email || '';
  form.elements.phone.value = session.patient?.phone || '';
  form.elements.language.value = session.patient?.preferredLanguage || i18n.getLanguage();
  document.querySelector('#profile-message').textContent = '';
}

function selectPanel(panelName) {
  document.querySelectorAll('#patient-portal .portal-tab').forEach((tab) => {
    const isActive = tab.dataset.panel === panelName;
    tab.classList.toggle('is-active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.querySelectorAll('#patient-portal .portal-panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${panelName}`;
  });
  if (panelName === 'appointments') void loadAppointments().catch(showApiError);
  if (panelName === 'records') void loadRecords().catch(showApiError);
  if (panelName === 'profile') updateProfileForm();
}

function mapDoctor(record, index) {
  const colors = ['teal', 'blue', 'lilac', 'peach'];
  const name = record.fullName || '';
  return {
    id: record.doctorId,
    name,
    specialty: record.specialization || '',
    bio: record.biography || '',
    fee: Number(record.consultationFee),
    initials: name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
    color: colors[index % colors.length]
  };
}

async function loadDoctors(query = '') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const result = await apiRequest(`doctors${params.size ? `?${params}` : ''}`);
  const feeLimit = document.querySelector('#fee-filter').value;
  session.doctors = result.map(mapDoctor).filter((doctor) => feeLimit === 'all' || doctor.fee <= Number(feeLimit));
  renderDoctors();
}

async function loadAppointments() {
  if (session.user?.role !== 'Patient') {
    session.appointments = [];
    renderAppointments();
    return;
  }
  session.appointments = await apiRequest('appointments');
  renderAppointments();
}

function renderDoctors(list = session.doctors) {
  const results = document.querySelector('#doctor-results');
  if (!list.length) {
    results.innerHTML = '<p class="empty-state">No verified doctors are currently available.</p>';
    return;
  }
  results.innerHTML = list.map((doctor) => `
    <article class="doctor-result">
      <span class="doctor-avatar avatar-${doctor.color}" aria-hidden="true">${escapeHtml(doctor.initials)}</span>
      <div class="doctor-details"><h4>${escapeHtml(doctor.name)}</h4><p>${escapeHtml(i18n.translate(doctor.specialty))}</p><button type="button" class="text-action" data-doctor-action="view" data-doctor-id="${escapeHtml(doctor.id)}">View profile</button></div>
      <div class="doctor-fee"><span>Consultation fee</span><strong>${formatRupees(Number(doctor.fee))}</strong><button type="button" class="button button-primary button-small" data-doctor-action="availability" data-doctor-id="${escapeHtml(doctor.id)}">View availability</button></div>
    </article>
  `).join('');
}

function showDoctorProfile(doctor) {
  const content = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">VERIFIED DOCTOR PROFILE</span>
      <h2 id="dialog-title">${escapeHtml(doctor.name)}</h2>
      <p>${escapeHtml(i18n.translate(doctor.specialty))}</p>
    </div>
    <div class="doctor-profile">
      <span class="doctor-avatar avatar-${doctor.color}" aria-hidden="true">${doctor.initials}</span>
      <p>${escapeHtml(doctor.bio || '')}</p>
      <div class="profile-fee"><span>Consultation fee</span><strong>${formatRupees(Number(doctor.fee))}</strong></div>
      <button type="button" class="button button-primary" data-doctor-action="availability" data-doctor-id="${doctor.id}">View availability</button>
    </div>
  `);
  openDialog(content);
}

async function showDoctorAvailabilityDialog(doctor) {
  if (!requireSignIn()) return;
  const from = new Date();
  const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  let slots;
  let checkoutEnabled;
  try {
    [slots, { checkoutEnabled }] = await Promise.all([
      apiRequest(`doctors/${encodeURIComponent(doctor.id)}/availability?${params}`),
      apiRequest('payments/config')
    ]);
  } catch (error) {
    showApiError(error);
    return;
  }
  const options = slots.map((slot) => `
    <li><span>${formatAppointmentDate(slot.startAt)} – ${formatAppointmentDate(slot.endAt)}</span>
      ${checkoutEnabled
        ? `<button type="button" class="button button-primary button-small" data-book-slot="${escapeHtml(slot.availabilityId)}" data-doctor-id="${escapeHtml(doctor.id)}">Book and pay</button>`
        : ''}
    </li>
  `).join('');
  const content = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">APPOINTMENT AVAILABILITY</span>
      <h2 id="dialog-title">Schedule a consultation</h2>
      <p>Available times for ${escapeHtml(doctor.name)} are shown from the scheduling service.</p>
    </div>
    <div class="dialog-form">
      ${slots.length
        ? `<p>Available times</p><ul class="availability-options">${options}</ul>`
        : '<p class="empty-state">No appointment times are available in the next 30 days.</p>'}
      <div class="booking-fee"><span>Consultation fee</span><strong>${formatRupees(Number(doctor.fee))}</strong></div>
      <p class="dialog-disclaimer">${checkoutEnabled
        ? 'Payment is processed using Razorpay test checkout. The appointment is confirmed only after the server verifies payment.'
        : 'Secure test checkout is not configured. No appointment can be reserved yet.'}</p>
    </div>
  `);
  openDialog(content);
}

function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => {
      script.remove();
      razorpayScriptPromise = undefined;
      reject(new Error('Razorpay checkout did not load. Please try again.'));
    }, 15000);
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.referrerPolicy = 'strict-origin';
    script.onload = () => {
      window.clearTimeout(timeout);
      if (window.Razorpay) resolve();
      else {
        razorpayScriptPromise = undefined;
        reject(new Error('Razorpay checkout could not be initialized.'));
      }
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      script.remove();
      razorpayScriptPromise = undefined;
      reject(new Error('Razorpay checkout could not be reached.'));
    };
    document.head.append(script);
  });
  return razorpayScriptPromise;
}

async function startAppointmentCheckout(doctor, availabilityId, button) {
  if (!requireSignIn()) return;
  button.disabled = true;
  let appointment;
  try {
    await loadRazorpayCheckout();
    appointment = await apiRequest('appointments', {
      method: 'POST',
      body: { doctorId: doctor.id, availabilityId }
    });
    await openRazorpayCheckout(appointment.appointmentId, doctor.name);
  } catch (error) {
    if (appointment?.appointmentId) {
      try {
        await apiRequest(`appointments/${encodeURIComponent(appointment.appointmentId)}`, { method: 'DELETE' });
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : 'Checkout could not be started.';
        const cleanup = cleanupError instanceof Error ? cleanupError.message : 'The pending appointment could not be cancelled.';
        showToast(`${primary} ${cleanup}`);
        return;
      }
    }
    button.disabled = false;
    showApiError(error);
  }
}

async function resumeAppointmentCheckout(appointment, button) {
  button.disabled = true;
  try {
    await loadRazorpayCheckout();
    await openRazorpayCheckout(appointment.appointmentId, appointment.doctorName);
  } catch (error) {
    button.disabled = false;
    showApiError(error);
  }
}

async function openRazorpayCheckout(appointmentId, doctorName) {
  const order = await apiRequest('payments/orders', {
    method: 'POST',
    body: { appointmentId }
  });
  const checkout = new window.Razorpay({
    key: order.keyId,
    amount: order.amount,
    currency: order.currency,
    name: 'Sonic A Square B Solutions',
    description: `Consultation with ${doctorName}`,
    order_id: order.orderId,
    handler: async (payment) => {
      try {
        await apiRequest('payments/verify', {
          method: 'POST',
          body: {
            orderId: payment.razorpay_order_id,
            paymentId: payment.razorpay_payment_id,
            signature: payment.razorpay_signature
          }
        });
        dialog.close();
        await loadAppointments();
        selectPanel('appointments');
        showToast('Payment verified. Your appointment is confirmed.');
      } catch (error) {
        showApiError(error);
        await loadAppointments().catch(showApiError);
      }
    },
    modal: {
      ondismiss: () => {
        showToast('Checkout closed. Appointment status will update when the provider confirms the payment result.');
        void loadAppointments().catch(showApiError);
      }
    },
    theme: { color: '#167b79' }
  });
  checkout.on('payment.failed', () => {
    showToast('Payment could not be completed. Appointment status is awaiting provider confirmation.');
    void loadAppointments().catch(showApiError);
  });
  checkout.open();
}

function formatAppointmentDate(date, time) {
  const locale = i18n.getLanguage() === 'te' ? 'te-IN' : 'en-IN';
  const value = time ? `${date}T${time}` : date;
  return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderAppointments() {
  const container = document.querySelector('#appointment-list');
  if (session.user?.role !== 'Patient') {
    container.innerHTML = '<p class="empty-state">Sign in to view your appointments.</p>';
    return;
  }
  const items = session.appointments.map((appointment) => `
    <article class="appointment-card">
      <div class="appointment-date"><span>${escapeHtml(i18n.translate(appointment.status === 'PendingPayment' ? 'Pending payment' : appointment.status))} · ${escapeHtml(i18n.translate(appointment.paymentStatus))}</span><strong>${formatAppointmentDate(appointment.startAt)}</strong><small>${formatRupees(Number(appointment.feeAmount))}</small></div>
      <div class="appointment-doctor"><strong>${escapeHtml(appointment.doctorName)}</strong><small>Reference: ${escapeHtml(appointment.appointmentId)}</small></div>
      <div class="appointment-actions">
        ${appointment.status === 'PendingPayment' && appointment.paymentStatus === 'Pending' && appointment.hasPaymentOrder
          ? `<button type="button" class="text-action" data-appointment-action="pay" data-appointment-id="${escapeHtml(appointment.appointmentId)}">Continue payment</button>`
          : ''}
        ${appointment.status === 'PendingPayment' && appointment.paymentStatus === 'Pending' && !appointment.hasPaymentOrder
          ? `<button type="button" class="text-action" data-appointment-action="cancel" data-appointment-id="${escapeHtml(appointment.appointmentId)}">Cancel reservation</button>`
          : ''}
        ${appointment.status === 'Confirmed' && appointment.paymentStatus === 'Paid' && Date.now() >= Date.parse(appointment.startAt) && Date.now() <= Date.parse(appointment.endAt) ? `<button type="button" class="button button-primary button-small" data-appointment-action="join" data-appointment-id="${escapeHtml(appointment.appointmentId)}">Join consultation</button>` : ''}
      </div>
    </article>
  `).join('');
  container.innerHTML = items || '<p class="empty-state">No appointments are associated with this account.</p>';
}

async function loadRecords() {
  if (session.user?.role !== 'Patient') {
    renderRecords([], []);
    return;
  }
  const [records, prescriptions] = await Promise.all([
    apiRequest('medical-records'),
    apiRequest('prescriptions')
  ]);
  renderRecords(records, prescriptions);
}

function renderRecords(records, prescriptions = []) {
  const content = document.querySelector('#records-content');
  if (!session.user || session.user.role !== 'Patient') {
    content.innerHTML = '<p class="empty-state">Sign in with a patient account to access your records.</p>';
    return;
  }
  if (!records.length && !prescriptions.length) {
    content.innerHTML = '<p class="empty-state">No medical records are associated with this account.</p>';
    return;
  }
  const documents = records.map((record) => `
    <article class="record-card">
      <span class="record-icon" aria-hidden="true">+</span>
      <div><strong>${escapeHtml(record.fileName)}</strong><span>${escapeHtml(record.recordType)} · ${formatAppointmentDate(record.createdAt)}</span></div>
      <button class="text-action" type="button" data-record-download="${escapeHtml(record.medicalRecordId)}">Download</button>
    </article>
  `).join('');
  const prescribedItems = prescriptions.map((prescription) => `
    <article class="clinical-item">
      <strong>${formatAppointmentDate(prescription.createdAt)}</strong>
      <p><b>${escapeHtml(prescription.itemName)}</b></p>
      <p>${escapeHtml(prescription.dosage || '—')} · ${escapeHtml(prescription.frequency || '—')} · ${escapeHtml(prescription.duration || '—')}</p>
      ${prescription.itemInstructions || prescription.instructions
        ? `<p>${escapeHtml(prescription.itemInstructions || prescription.instructions)}</p>`
        : ''}
    </article>
  `).join('');
  content.innerHTML = `
    ${documents ? `<section><h4>Medical documents</h4>${documents}</section>` : ''}
    ${prescribedItems ? `<section><h4>Prescriptions</h4>${prescribedItems}</section>` : ''}
  `;
}

document.addEventListener('click', async (event) => {
  const doctorAccess = event.target.closest('[data-doctor-access]');
  if (doctorAccess) {
    event.preventDefault();
    if (session.user?.role === 'Doctor') {
      document.querySelector('#doctor-login').hidden = false;
      document.querySelector('#patient-portal').hidden = true;
      document.querySelector('#doctor-login').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      showAuthDialog('login', 'Doctor');
    }
    return;
  }
  if (event.target.closest('[data-doctor-signout]')) {
    try {
      await apiRequest('auth/logout', { method: 'POST' });
      clearAuthenticatedAccount();
      showToast('You are signed out.');
    } catch (error) {
      showApiError(error);
    }
    return;
  }
  const doctorPanelButton = event.target.closest('[data-open-doctor-panel]');
  if (doctorPanelButton) {
    const panelName = doctorPanelButton.dataset.openDoctorPanel;
    if (session.user?.role === 'Doctor') selectDoctorPanel(panelName);
    else showAuthDialog('login', 'Doctor');
    return;
  }
  const doctorAppointmentButton = event.target.closest('[data-doctor-appointment]');
  if (doctorAppointmentButton && session.user?.role === 'Doctor') {
    const action = doctorAppointmentButton.dataset.doctorAppointment;
    if (action === 'reject' || action === 'complete') {
      try {
        await apiRequest(`doctors/appointments/${encodeURIComponent(doctorAppointmentButton.dataset.appointmentId)}/status`, {
          method: 'PATCH',
          body: { status: action === 'reject' ? 'Rejected' : 'Completed' }
        });
        await loadDoctorAppointments();
      } catch (error) {
        showApiError(error);
      }
    }
    return;
  }
  const control = event.target.closest('[data-auth-action]');
  if (!control) return;
  const action = control.dataset.authAction;
  if (action === 'logout') {
    try {
      await apiRequest('auth/logout', { method: 'POST' });
      clearAuthenticatedAccount();
      showToast('You are signed out.');
    } catch (error) {
      showApiError(error);
    }
    return;
  }
  if (control.tagName === 'A') event.preventDefault();
  showAuthDialog(action);
});

function clearAuthenticatedAccount() {
  session.user = null;
  session.patient = null;
  session.doctor = null;
  session.doctorProfile = null;
  session.appointments = [];
  session.doctorAppointments = [];
  session.doctorAvailability = [];
  session.doctorCredentialStatus = '';
  document.querySelector('#doctor-login').hidden = true;
  document.querySelector('#patient-portal').hidden = false;
  updateAccount();
  updateDoctorAccount();
  selectPanel('doctors');
  renderAppointments();
  renderRecords([]);
}

document.querySelectorAll('#patient-portal .portal-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.panel;
    if (target !== 'doctors' && !requireSignIn()) return;
    selectPanel(target);
  });
});

document.querySelector('#doctor-search').addEventListener('submit', (event) => {
  event.preventDefault();
  void loadDoctors(document.querySelector('#doctor-query').value.trim()).catch(showApiError);
});

document.querySelector('#fee-filter').addEventListener('change', () => {
  void loadDoctors(document.querySelector('#doctor-query').value.trim()).catch(showApiError);
});

document.querySelector('#doctor-results').addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-doctor-action]');
  if (!actionButton) return;
  const doctor = session.doctors.find((item) => item.id === actionButton.dataset.doctorId);
  if (!doctor) return;
  if (actionButton.dataset.doctorAction === 'view') showDoctorProfile(doctor);
  if (actionButton.dataset.doctorAction === 'availability') void showDoctorAvailabilityDialog(doctor);
});

dialogContent.addEventListener('click', (event) => {
  const slotButton = event.target.closest('[data-book-slot]');
  if (slotButton) {
    const doctor = session.doctors.find((item) => item.id === slotButton.dataset.doctorId);
    if (doctor) void startAppointmentCheckout(doctor, slotButton.dataset.bookSlot, slotButton);
    return;
  }
  const actionButton = event.target.closest('[data-doctor-action]');
  if (!actionButton || actionButton.dataset.doctorAction !== 'availability') return;
  const doctor = session.doctors.find((item) => item.id === actionButton.dataset.doctorId);
  if (doctor) void showDoctorAvailabilityDialog(doctor);
});

document.querySelector('#appointment-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-appointment-action]');
  if (!button) return;
  const action = button.dataset.appointmentAction;
  const appointmentId = button.dataset.appointmentId;
  if (action === 'pay') {
    const appointment = session.appointments.find((item) => item.appointmentId === appointmentId);
    if (appointment) await resumeAppointmentCheckout(appointment, button);
    return;
  }
  if (action === 'cancel') {
    try {
      await apiRequest(`appointments/${encodeURIComponent(appointmentId)}`, { method: 'DELETE' });
      await loadAppointments();
    } catch (error) {
      showApiError(error);
    }
    return;
  }
  if (action === 'join') {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const result = await apiRequest(`consultations/${encodeURIComponent(appointmentId)}/join`, { method: 'POST' });
      const joinUrl = new URL(result.joinUrl);
      if (joinUrl.protocol !== 'https:') throw new Error('The consultation service returned an insecure link.');
      if (popup) popup.location.href = joinUrl.href;
      else showToast('Allow pop-ups to open the secure consultation link.');
    } catch (error) {
      popup?.close();
      showApiError(error);
    }
  }
});

document.querySelector('#records-content').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-record-download]');
  if (!button || session.user?.role !== 'Patient') return;
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  try {
    const result = await apiRequest(`medical-records/${encodeURIComponent(button.dataset.recordDownload)}/url`);
    const downloadUrl = new URL(result.url);
    if (downloadUrl.protocol !== 'https:') throw new Error('The document service returned an insecure link.');
    if (popup) popup.location.href = downloadUrl.href;
    else showToast('Allow pop-ups to open the secure document.');
  } catch (error) {
    popup?.close();
    showApiError(error);
  }
});

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const form = event.currentTarget;
  const message = document.querySelector('#profile-message');
  try {
    const language = form.elements.language.value;
    const profile = await apiRequest('patients/me', {
      method: 'PATCH',
      body: {
        fullName: form.elements.name.value.trim(),
        phone: form.elements.phone.value.trim() || null
      }
    });
    await apiRequest('profile/language', { method: 'PATCH', body: { language } });
    session.patient = {
      name: profile.fullName,
      email: profile.email,
      phone: profile.phone || '',
      preferredLanguage: language
    };
    i18n.setLanguage(language);
    updateAccount();
    message.textContent = 'Your account profile was updated.';
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Your profile could not be updated.';
  }
});

document.querySelectorAll('[data-doctor-panel]').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (session.user?.role === 'Doctor') selectDoctorPanel(tab.dataset.doctorPanel);
  });
});

document.querySelector('#doctor-availability-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (session.user?.role !== 'Doctor') return;
  const form = event.currentTarget;
  const startAt = form.elements.startAt.value;
  const endAt = form.elements.endAt.value;
  if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
    showToast('Choose a valid future start and end time.');
    return;
  }
  try {
    await apiRequest('doctors/availability', {
      method: 'POST',
      body: { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() }
    });
    form.reset();
    document.querySelector('#availability-message').textContent = 'Appointment time added to your account.';
    await loadDoctorAvailability();
  } catch (error) {
    document.querySelector('#availability-message').textContent =
      error instanceof Error ? error.message : 'Availability could not be saved.';
  }
});

document.querySelector('#doctor-availability-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-availability-remove]');
  if (!button || session.user?.role !== 'Doctor') return;
  try {
    await apiRequest(`doctors/availability/${encodeURIComponent(button.dataset.availabilityRemove)}`, { method: 'DELETE' });
    await loadDoctorAvailability();
  } catch (error) {
    showApiError(error);
  }
});

document.querySelector('#doctor-profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (session.user?.role !== 'Doctor') return;
  const form = event.currentTarget;
  try {
    session.doctorProfile = await apiRequest('doctors/me', {
      method: 'PATCH',
      body: {
        fullName: form.elements.name.value.trim(),
        specialization: form.elements.specialty.value.trim() || null,
        consultationFee: form.elements.fee.value ? Number(form.elements.fee.value) : null,
        biography: form.elements.bio.value.trim() || null
      }
    });
    session.doctor.name = session.doctorProfile.fullName;
    updateDoctorAccount();
    document.querySelector('#doctor-profile-message').textContent = 'Professional profile updated.';
  } catch (error) {
    document.querySelector('#doctor-profile-message').textContent =
      error instanceof Error ? error.message : 'Professional profile could not be saved.';
  }
});

document.querySelector('#clinical-appointment').addEventListener('change', () => {
  void renderDoctorHistory();
});

document.querySelector('#clinical-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (session.user?.role !== 'Doctor') {
    showToast('Sign in with a doctor account to continue.');
    return;
  }
  const form = event.currentTarget;
  const appointmentId = form.elements.appointmentId.value;
  const itemName = form.elements.itemName.value.trim();
  if (!appointmentId || !itemName) {
    showToast('Select an authorized appointment and enter the prescribed item.');
    return;
  }
  try {
    await apiRequest('prescriptions', {
      method: 'POST',
      body: {
        appointmentId,
        items: [{
          itemName,
          dosage: form.elements.dosage.value.trim() || null,
          frequency: form.elements.frequency.value.trim() || null,
          duration: form.elements.duration.value.trim() || null,
          instructions: form.elements.instructions.value.trim() || null
        }]
      }
    });
    form.reset();
    document.querySelector('#clinical-message').textContent = 'Prescription was recorded for the authorized appointment.';
    await loadPrescriptions();
  } catch (error) {
    document.querySelector('#clinical-message').textContent =
      error instanceof Error ? error.message : 'Prescription could not be recorded.';
  }
});

i18n.initialize();
updateAccount();
updateDoctorAccount();
renderAppointments();
renderRecords([]);
void loadDoctors().catch(showApiError);

async function restoreAccount() {
  try {
    const result = await apiRequest('auth/me');
    await openAuthenticatedAccount(result.user);
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 401) showApiError(error);
  }
}

void restoreAccount();

window.addEventListener('sonic-language-change', (event) => {
  const language = event.detail.language;
  const preferenceChanged = Boolean(session.user) &&
    (session.patient ? session.patient.preferredLanguage !== language : true);
  if (session.patient) session.patient.preferredLanguage = language;
  const profileLanguage = document.querySelector('#profile-form [name="language"]');
  if (profileLanguage) profileLanguage.value = language;
  if (preferenceChanged) {
    void apiRequest('profile/language', { method: 'PATCH', body: { language } }).catch(showApiError);
  }
});

document.addEventListener('invalid', (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
  const validity = field.validity;
  let message = 'Please enter a valid value.';
  if (validity.valueMissing) message = 'Please fill out this field.';
  else if (validity.typeMismatch && field.type === 'email') message = 'Please enter a valid email address.';
  else if (validity.rangeUnderflow && field.type === 'date' && field.min) {
    message = i18n.translate('Please choose a date on or after {min}.', { min: field.min });
    field.setCustomValidity(message);
    return;
  }
  else if (validity.rangeUnderflow && field.min) message = `Please enter a number greater than or equal to {min}.`.replace('{min}', field.min);
  else if (validity.rangeOverflow && field.max) message = `Please enter a number less than or equal to {max}.`.replace('{max}', field.max);
  else if (validity.tooLong && field.maxLength >= 0) message = `Please shorten this text to {max} characters or fewer.`.replace('{max}', String(field.maxLength));
  else if (validity.tooShort && field.minLength >= 0) message = `Please lengthen this text to {min} characters or more.`.replace('{min}', String(field.minLength));
  field.setCustomValidity(i18n.translate(message));
}, true);

document.addEventListener('input', (event) => {
  const field = event.target;
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
    field.setCustomValidity('');
  }
}, true);

document.addEventListener('change', (event) => {
  const field = event.target;
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
    field.setCustomValidity('');
  }
}, true);
