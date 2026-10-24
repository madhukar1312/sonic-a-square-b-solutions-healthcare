const menuToggle = document.querySelector('.menu-toggle');
const primaryNav = document.querySelector('.primary-nav');
const dialog = document.querySelector('#portal-dialog');
const dialogContent = document.querySelector('#dialog-content');
const toast = document.querySelector('#portal-toast');

const doctors = [
  { id: 'maya-shah', name: 'Dr. Maya Shah', specialty: 'General physician', fee: 800, initials: 'MS', color: 'teal', bio: 'Primary care and everyday health concerns. 12 years of experience.' },
  { id: 'arjun-mehta', name: 'Dr. Arjun Mehta', specialty: 'Cardiologist', fee: 1500, initials: 'AM', color: 'blue', bio: 'Heart health, prevention, and cardiovascular wellbeing. 15 years of experience.' },
  { id: 'leena-rao', name: 'Dr. Leena Rao', specialty: 'Dermatologist', fee: 1200, initials: 'LR', color: 'lilac', bio: 'Skin health and common dermatological concerns. 9 years of experience.' },
  { id: 'kabir-iyer', name: 'Dr. Kabir Iyer', specialty: 'General physician', fee: 700, initials: 'KI', color: 'peach', bio: 'Family medicine and preventive care. 8 years of experience.' }
];

const session = {
  patient: null,
  appointments: [],
  uploadedFiles: [],
  recordsAuthorized: false,
  activeDoctor: null,
  doctor: null,
  doctorProfile: null,
  doctorAppointments: [
    { id: 'REQ-2041', patient: 'Sam Taylor', date: '2026-10-26', time: '09:30', type: 'Video', status: 'Pending' },
    { id: 'REQ-2042', patient: 'Jordan Lee', date: '2026-10-26', time: '11:00', type: 'Audio', status: 'Pending' },
    { id: 'REQ-2043', patient: 'Casey Morgan', date: '2026-10-27', time: '14:00', type: 'Video', status: 'Accepted' }
  ],
  clinicalItems: [],
  doctorRecordsAuthorized: false,
  doctorCredentialStatus: 'Not submitted in this demo session.',
  doctorAvailability: null
};

if (menuToggle && primaryNav) {
  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Open navigation menu' : 'Close navigation menu');
    primaryNav.classList.toggle('is-open', !isOpen);
  });

  primaryNav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'Open navigation menu');
      primaryNav.classList.remove('is-open');
    });
  });
}

document.querySelector('#year').textContent = new Date().getFullYear();

function showToast(message) {
  toast.textContent = message;
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
  if (session.patient) return true;
  showAuthDialog('login');
  return false;
}

function showAuthDialog(mode) {
  const registering = mode === 'register';
  const form = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">PATIENT PORTAL · DEMO</span>
      <h2 id="dialog-title">${registering ? 'Create your patient profile' : 'Welcome back'}</h2>
      <p>${registering ? 'Set up a temporary profile for this browser session.' : 'Enter your email to start a temporary demo session.'}</p>
    </div>
    <form class="dialog-form" id="auth-form">
      ${registering ? '<label>Full name<input name="name" autocomplete="name" required maxlength="80" placeholder="Your name"></label>' : ''}
      <label>Email address<input name="email" type="email" autocomplete="email" required maxlength="120" placeholder="you@example.com"></label>
      <p class="dialog-disclaimer">Demo only. No password or account is created, and your details are cleared when this page is refreshed.</p>
      <button class="button button-primary" type="submit">${registering ? 'Continue' : 'Start demo session'}</button>
    </form>
    <button type="button" class="dialog-switch" data-auth-action="${registering ? 'login' : 'register'}">${registering ? 'Already have a profile? Sign in' : 'New here? Create a profile'}</button>
  `);
  openDialog(form);

  document.querySelector('#auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email')).trim();
    const name = registering ? String(data.get('name')).trim() : (session.patient?.name || email.split('@')[0]);
    session.patient = { name, email, phone: '' };
    session.recordsAuthorized = false;
    session.doctor = null;
    session.doctorProfile = null;
    session.clinicalItems = [];
    session.doctorRecordsAuthorized = false;
    document.querySelector('#doctor-login').hidden = true;
    document.querySelector('#patient-portal').hidden = false;
    dialog.close();
    updateAccount();
    updateDoctorAccount();
    updateProfileForm();
    showToast(`Demo session started for ${name}.`);
    if (registering) selectPanel('profile');
  });
}

function showDoctorAuthDialog() {
  const content = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">DOCTOR WORKSPACE · DEMO</span>
      <h2 id="dialog-title">Doctor demo access</h2>
      <p>Enter a sample email to preview the separate doctor workspace.</p>
    </div>
    <form class="dialog-form" id="doctor-auth-form">
      <label>Email address<input name="email" type="email" autocomplete="email" required maxlength="120" placeholder="doctor@example.com"></label>
      <p class="dialog-disclaimer">This prototype does not authenticate users or provide secure access. No password or real account is used.</p>
      <button class="button button-primary" type="submit">Enter doctor demo</button>
    </form>
  `);
  openDialog(content);
  document.querySelector('#doctor-auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email')).trim();
    session.patient = null;
    session.appointments = [];
    session.uploadedFiles = [];
    session.recordsAuthorized = false;
    session.doctor = { name: 'Dr. Alex Morgan', email };
    session.doctorProfile = {
      name: 'Dr. Alex Morgan',
      specialty: 'General physician',
      experience: 10,
      fee: 900,
      bio: 'Primary care and preventive health consultations.'
    };
    session.doctorRecordsAuthorized = false;
    session.clinicalItems = [];
    session.doctorCredentialStatus = 'Not submitted in this demo session.';
    session.doctorAvailability = null;
    session.doctorAppointments = [
      { id: 'REQ-2041', patient: 'Sam Taylor', date: '2026-10-26', time: '09:30', type: 'Video', status: 'Pending' },
      { id: 'REQ-2042', patient: 'Jordan Lee', date: '2026-10-26', time: '11:00', type: 'Audio', status: 'Pending' },
      { id: 'REQ-2043', patient: 'Casey Morgan', date: '2026-10-27', time: '14:00', type: 'Video', status: 'Accepted' }
    ];
    dialog.close();
    updateAccount();
    updateDoctorAccount();
    selectDoctorPanel('overview');
    document.querySelector('#patient-portal').hidden = true;
    document.querySelector('#doctor-login').hidden = false;
    renderDoctorAppointments();
    document.querySelector('#doctor-login').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Doctor demo workspace opened. No account was authenticated.');
  });
}

function updateDoctorAccount() {
  const account = document.querySelector('#doctor-account');
  const name = document.createElement('strong');
  name.textContent = session.doctor?.name || 'Doctor demo';
  const email = document.createElement('small');
  email.textContent = session.doctor?.email || 'Demo access only';
  const details = document.createElement('span');
  details.append(name, email);
  const avatar = document.createElement('span');
  avatar.className = 'account-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = session.doctor?.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'D';
  account.replaceChildren(avatar, details);
  const greeting = document.querySelector('#doctor-overview-heading');
  greeting.textContent = `Good day, ${session.doctor?.name || 'doctor'}`;
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
  if (panelName === 'appointments' || panelName === 'overview') renderDoctorAppointments();
  if (panelName === 'credentials') {
    document.querySelector('#credential-status').textContent = session.doctorCredentialStatus;
  }
  if (panelName === 'consultation') renderDoctorHistory();
}

function renderDoctorAppointments() {
  const pending = session.doctorAppointments.filter((appointment) => appointment.status === 'Pending').length;
  document.querySelector('#pending-count').textContent = String(pending);
  const renderList = (appointments) => appointments.map((appointment) => `
    <article class="appointment-card doctor-appointment-card">
      <div class="appointment-date"><span>${appointment.status} · sample request</span><strong>${formatAppointmentDate(appointment.date, appointment.time)}</strong><small>${appointment.type} consultation · reference ${appointment.id}</small></div>
      <div class="appointment-doctor"><strong>${appointment.patient}</strong><span>Fictional patient</span><small>Sample appointment request</small></div>
      <div class="appointment-actions">
        ${appointment.status === 'Pending' ? `<button type="button" class="button button-primary button-small" data-doctor-appointment="accept" data-appointment-id="${appointment.id}">Accept</button><button type="button" class="text-action" data-doctor-appointment="reject" data-appointment-id="${appointment.id}">Reject</button>` : `<button type="button" class="button button-outline button-small" data-doctor-appointment="consult" data-appointment-id="${appointment.id}">Consultation preview</button>`}
      </div>
    </article>
  `).join('');
  document.querySelector('#doctor-appointment-list').innerHTML = renderList(session.doctorAppointments) || '<p class="empty-state">No sample appointment requests.</p>';
  document.querySelector('#doctor-upcoming-list').innerHTML = renderList(session.doctorAppointments.slice(0, 2));
}

function renderDoctorHistory() {
  const history = document.querySelector('#doctor-history-content');
  if (!session.doctor) {
    history.innerHTML = '<p class="empty-state">Doctor demo access is required.</p>';
  } else if (!session.doctorRecordsAuthorized) {
    history.innerHTML = '<p class="empty-state">Authorize access to view fictional patient history.</p>';
  } else {
    history.innerHTML = '<div class="recommendation-card"><strong>Authorized sample history · patient Sam Taylor</strong><ul><li>Previous sample consultation: routine primary care review.</li><li>Sample medication history: no details supplied.</li><li>All history is fictional and visible only during this doctor demo session.</li></ul></div>';
  }
  document.querySelector('#doctor-records-authorized').checked = session.doctorRecordsAuthorized;
}

function renderClinicalItems() {
  const container = document.querySelector('#clinical-items');
  container.innerHTML = session.clinicalItems.map((item) => `
    <article class="clinical-item">
      <strong>Demo consultation saved · ${item.date}</strong>
      <p><b>Notes:</b> ${escapeHtml(item.notes)}</p>
      ${item.prescription ? `<p><b>Prescription draft:</b> ${escapeHtml(item.prescription)}</p>` : ''}
      ${item.prescriptionStatus ? `<p><b>Status:</b> ${escapeHtml(item.prescriptionStatus)}</p>` : ''}
      ${item.followup ? `<p><b>Follow-up:</b> ${escapeHtml(item.followup)}</p>` : ''}
    </article>
  `).join('');
}

function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}

function exitDoctorDemo() {
  session.doctor = null;
  session.doctorProfile = null;
  session.clinicalItems = [];
  session.doctorRecordsAuthorized = false;
  session.doctorCredentialStatus = 'Not submitted in this demo session.';
  session.doctorAvailability = null;
  document.querySelector('#doctor-login').hidden = true;
  document.querySelector('#patient-portal').hidden = false;
  updateDoctorAccount();
  selectPanel('doctors');
  document.querySelector('#patient-portal').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('Doctor demo closed. The patient portal remains signed out.');
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
  if (panelName === 'appointments') renderAppointments();
  if (panelName === 'records') renderRecords();
  if (panelName === 'profile') updateProfileForm();
}

function renderDoctors(list = doctors) {
  const results = document.querySelector('#doctor-results');
  if (!list.length) {
    results.innerHTML = '<p class="empty-state">No sample doctors match your search. Try a different name or specialty.</p>';
    return;
  }
  results.innerHTML = list.map((doctor) => `
    <article class="doctor-result">
      <span class="doctor-avatar avatar-${doctor.color}" aria-hidden="true">${doctor.initials}</span>
      <div class="doctor-details"><h4>${doctor.name}</h4><p>${doctor.specialty}</p><button type="button" class="text-action" data-doctor-action="view" data-doctor-id="${doctor.id}">View profile</button></div>
      <div class="doctor-fee"><span>Consultation fee</span><strong>₹${doctor.fee.toLocaleString('en-IN')}</strong><button type="button" class="button button-primary button-small" data-doctor-action="book" data-doctor-id="${doctor.id}">Book</button></div>
    </article>
  `).join('');
}

function showDoctorProfile(doctor) {
  const content = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">SAMPLE DOCTOR PROFILE</span>
      <h2 id="dialog-title">${doctor.name}</h2>
      <p>${doctor.specialty}</p>
    </div>
    <div class="doctor-profile">
      <span class="doctor-avatar avatar-${doctor.color}" aria-hidden="true">${doctor.initials}</span>
      <p>${doctor.bio}</p>
      <div class="profile-fee"><span>Sample consultation fee</span><strong>₹${doctor.fee.toLocaleString('en-IN')}</strong></div>
      <button type="button" class="button button-primary" data-doctor-action="book" data-doctor-id="${doctor.id}">Schedule consultation</button>
    </div>
  `);
  openDialog(content);
}

function showBookingDialog(doctor) {
  if (!requireSignIn()) return;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const content = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">SAMPLE BOOKING</span>
      <h2 id="dialog-title">Schedule a consultation</h2>
      <p>Choose a time with ${doctor.name}. This demo does not confirm a real appointment.</p>
    </div>
    <form class="dialog-form" id="booking-form">
      <label>Appointment date<input name="date" type="date" min="${minDate}" required></label>
      <label>Available time<select name="time" required><option value="">Choose a time</option><option>09:00</option><option>10:30</option><option>12:00</option><option>14:30</option><option>16:00</option></select></label>
      <label>Consultation type<select name="type" required><option value="Video">Video consultation</option><option value="Audio">Audio consultation</option></select></label>
      <div class="booking-fee"><span>Sample fee</span><strong>₹${doctor.fee.toLocaleString('en-IN')}</strong></div>
      <p class="dialog-disclaimer">No payment is collected. Appointment slots and fees shown are illustrative only.</p>
      <button class="button button-primary" type="submit">Confirm demo booking</button>
    </form>
  `);
  openDialog(content);
  document.querySelector('#booking-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const booking = new FormData(event.currentTarget);
    const appointmentDate = new Date(`${booking.get('date')}T${booking.get('time')}`);
    if (Number.isNaN(appointmentDate.getTime()) || appointmentDate <= new Date()) {
      showToast('Choose a future date and time.');
      return;
    }
    session.appointments.unshift({
      id: `DEMO-${Date.now().toString(36).toUpperCase()}`,
      doctor,
      date: String(booking.get('date')),
      time: String(booking.get('time')),
      type: String(booking.get('type')),
      fee: doctor.fee
    });
    dialog.close();
    selectPanel('appointments');
    showToast('Demo booking added to your appointment list.');
    document.querySelector('#patient-portal').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function formatAppointmentDate(date, time) {
  return new Date(`${date}T${time}`).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderAppointments() {
  const container = document.querySelector('#appointment-list');
  if (!session.patient) {
    container.innerHTML = '<p class="empty-state">Sign in to view your appointments.</p>';
    return;
  }
  const items = session.appointments.map((appointment) => `
    <article class="appointment-card">
      <div class="appointment-date"><span>${appointment.type} consultation</span><strong>${formatAppointmentDate(appointment.date, appointment.time)}</strong><small>Sample fee: ₹${appointment.fee.toLocaleString('en-IN')}</small></div>
      <div class="appointment-doctor"><strong>${appointment.doctor.name}</strong><span>${appointment.doctor.specialty}</span><small>Reference: ${appointment.id}</small></div>
      <div class="appointment-actions">
        <button type="button" class="button button-primary button-small" data-appointment-action="join" data-appointment-id="${appointment.id}">Join ${appointment.type.toLowerCase()} visit</button>
        <button type="button" class="text-action" data-appointment-action="confirmation" data-appointment-id="${appointment.id}">Download confirmation</button>
        <button type="button" class="text-action" data-appointment-action="receipt" data-appointment-id="${appointment.id}">Download receipt</button>
      </div>
    </article>
  `).join('');
  const history = `
    <h4 class="subsection-title">Appointment history</h4>
    <article class="appointment-card history-card">
      <div class="appointment-date"><span>Completed · Sample history</span><strong>September 18, 2026 · 10:30 AM</strong><small>Video consultation</small></div>
      <div class="appointment-doctor"><strong>Dr. Maya Shah</strong><span>General physician</span><small>Follow-up: Routine check-in if symptoms continue.</small></div>
      <div class="appointment-actions"><button type="button" class="text-action" data-appointment-action="sample-confirmation">Download sample confirmation</button><button type="button" class="text-action" data-appointment-action="sample-receipt">Download sample receipt</button></div>
    </article>`;
  container.innerHTML = `${items || '<p class="empty-state">No demo bookings yet. Browse doctors to schedule a sample consultation.</p>'}${history}`;
}

function renderRecords() {
  const content = document.querySelector('#records-content');
  const authorization = document.querySelector('#records-authorized');
  authorization.checked = session.recordsAuthorized;
  if (!session.patient) {
    authorization.disabled = true;
    content.innerHTML = '<p class="empty-state">Sign in to access the sample records area.</p>';
    return;
  }
  authorization.disabled = false;
  if (!session.recordsAuthorized) {
    content.innerHTML = '<p class="empty-state">Authorize access to view sample documents and recommendations.</p>';
    return;
  }
  content.innerHTML = `
    <h4 class="subsection-title">Authorized sample documents</h4>
    <div class="record-card"><span class="record-icon" aria-hidden="true">Rx</span><div><strong>Sample prescription</strong><span>Dr. Maya Shah · September 18, 2026</span></div><button class="text-action" type="button" data-record-download="prescription">Download</button></div>
    <div class="record-card"><span class="record-icon" aria-hidden="true">+</span><div><strong>Sample consultation summary</strong><span>Fictional medical document · September 18, 2026</span></div><button class="text-action" type="button" data-record-download="medical">Download</button></div>
    <div class="recommendation-card"><strong>Follow-up recommendations · sample</strong><ul><li>Keep a note of questions to discuss at your next visit.</li><li>Arrange a follow-up with a qualified clinician if your symptoms continue.</li><li>Seek urgent local medical care for severe or rapidly worsening symptoms.</li></ul></div>
  `;
}

function downloadText(filename, text) {
  const file = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadAppointment(appointment, kind) {
  const label = kind === 'receipt' ? 'SAMPLE RECEIPT' : 'SAMPLE APPOINTMENT CONFIRMATION';
  const contents = [
    'SONIC HEALTHCARE — DEMONSTRATION ONLY',
    label,
    'Not a real booking, payment receipt, or medical document.',
    `Patient: ${session.patient.name}`,
    `Doctor: ${appointment.doctor.name} (${appointment.doctor.specialty})`,
    `Date: ${formatAppointmentDate(appointment.date, appointment.time)}`,
    `Consultation: ${appointment.type}`,
    `Sample fee: ₹${appointment.fee.toLocaleString('en-IN')}`,
    `Reference: ${appointment.id}`
  ].join('\n');
  downloadText(`${kind}-${appointment.id.toLowerCase()}.txt`, contents);
}

function showConsultationNotice(type) {
  const content = elementFromHtml(`
    <div class="dialog-heading">
      <span class="eyebrow">CONSULTATION PREVIEW</span>
      <h2 id="dialog-title">${type} consultation</h2>
      <p>Telehealth is not connected in this prototype. No call, microphone, or camera session has been started.</p>
    </div>
    <div class="call-preview"><span aria-hidden="true">${type === 'Video' ? '▣' : '◖'}</span><strong>Ready for your clinician</strong><p>A secure, provider-connected consultation service is needed to join a real appointment.</p></div>
  `);
  openDialog(content);
}

document.addEventListener('click', (event) => {
  const doctorAccess = event.target.closest('[data-doctor-access]');
  if (doctorAccess) {
    event.preventDefault();
    if (session.doctor) {
      document.querySelector('#doctor-login').hidden = false;
      document.querySelector('#patient-portal').hidden = true;
      document.querySelector('#doctor-login').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      showDoctorAuthDialog();
    }
    return;
  }
  if (event.target.closest('[data-doctor-signout]')) {
    exitDoctorDemo();
    return;
  }
  const doctorPanelButton = event.target.closest('[data-doctor-panel], [data-open-doctor-panel]');
  if (doctorPanelButton) {
    const panelName = doctorPanelButton.dataset.doctorPanel || doctorPanelButton.dataset.openDoctorPanel;
    selectDoctorPanel(panelName);
    return;
  }
  const doctorAppointmentButton = event.target.closest('[data-doctor-appointment]');
  if (doctorAppointmentButton && session.doctor) {
    const appointment = session.doctorAppointments.find((item) => item.id === doctorAppointmentButton.dataset.appointmentId);
    if (!appointment) return;
    const action = doctorAppointmentButton.dataset.doctorAppointment;
    if (action === 'accept' || action === 'reject') {
      appointment.status = action === 'accept' ? 'Accepted' : 'Declined';
      renderDoctorAppointments();
      showToast(`Sample appointment ${action === 'accept' ? 'accepted' : 'declined'}.`);
    } else {
      selectDoctorPanel('consultation');
      showToast('Consultation preview only; no call or patient data is connected.');
    }
    return;
  }
  const doctorCallButton = event.target.closest('[data-doctor-call]');
  if (doctorCallButton && session.doctor) {
    const type = doctorCallButton.dataset.doctorCall;
    const content = elementFromHtml(`<div class="dialog-heading"><span class="eyebrow">CONSULTATION PREVIEW</span><h2 id="dialog-title">${type} consultation</h2><p>No call, microphone, or camera is connected in this prototype.</p></div><div class="call-preview"><strong>Secure telehealth integration required</strong><p>This screen is a visual preview only.</p></div>`);
    openDialog(content);
    return;
  }
  const control = event.target.closest('[data-auth-action]');
  if (!control) return;
  const action = control.dataset.authAction;
  if (action === 'logout') {
    session.patient = null;
    session.appointments = [];
    session.uploadedFiles = [];
    session.recordsAuthorized = false;
    updateAccount();
    selectPanel('doctors');
    renderRecords();
    renderAppointments();
    document.querySelector('#uploaded-files').replaceChildren();
    showToast('You have signed out of the demo session.');
    return;
  }
  if (control.tagName === 'A') event.preventDefault();
  showAuthDialog(action);
});

document.querySelectorAll('#patient-portal .portal-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.panel;
    if (target !== 'doctors' && !requireSignIn()) return;
    selectPanel(target);
  });
});

document.querySelector('#doctor-search').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = document.querySelector('#doctor-query').value.trim().toLocaleLowerCase();
  const feeLimit = document.querySelector('#fee-filter').value;
  const matches = doctors.filter((doctor) => {
    const matchesText = `${doctor.name} ${doctor.specialty}`.toLocaleLowerCase().includes(query);
    const matchesFee = feeLimit === 'all' || doctor.fee <= Number(feeLimit);
    return matchesText && matchesFee;
  });
  renderDoctors(matches);
});

document.querySelector('#doctor-results').addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-doctor-action]');
  if (!actionButton) return;
  const doctor = doctors.find((item) => item.id === actionButton.dataset.doctorId);
  if (!doctor) return;
  if (actionButton.dataset.doctorAction === 'view') showDoctorProfile(doctor);
  if (actionButton.dataset.doctorAction === 'book') showBookingDialog(doctor);
});

dialogContent.addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-doctor-action]');
  if (!actionButton || actionButton.dataset.doctorAction !== 'book') return;
  const doctor = doctors.find((item) => item.id === actionButton.dataset.doctorId);
  if (doctor) showBookingDialog(doctor);
});

document.querySelector('#appointment-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-appointment-action]');
  if (!button) return;
  const action = button.dataset.appointmentAction;
  if (action.startsWith('sample-')) {
    const type = action === 'sample-receipt' ? 'receipt' : 'confirmation';
    downloadText(`sample-${type}.txt`, `SONIC HEALTHCARE — DEMONSTRATION ONLY\nSAMPLE ${type.toUpperCase()}\nFictional appointment for Dr. Maya Shah.\nSeptember 18, 2026 · 10:30 AM\nNot a real booking, medical document, or payment receipt.`);
    return;
  }
  const appointment = session.appointments.find((item) => item.id === button.dataset.appointmentId);
  if (!appointment) return;
  if (action === 'join') showConsultationNotice(appointment.type);
  if (action === 'confirmation' || action === 'receipt') downloadAppointment(appointment, action);
});

document.querySelector('#records-authorized').addEventListener('change', (event) => {
  session.recordsAuthorized = event.currentTarget.checked;
  renderRecords();
});

document.querySelector('#records-content').addEventListener('click', (event) => {
  const button = event.target.closest('[data-record-download]');
  if (!button || !session.patient || !session.recordsAuthorized) return;
  if (button.dataset.recordDownload === 'prescription') {
    downloadText('sample-prescription.txt', 'SONIC HEALTHCARE — FICTIONAL SAMPLE PRESCRIPTION\nDemonstration only. Not medical advice or a valid prescription.\nPatient: Sample patient\nClinician: Dr. Maya Shah\nDate: September 18, 2026\nFor real medication advice, consult a qualified clinician.');
  } else {
    downloadText('sample-medical-document.txt', 'SONIC HEALTHCARE — FICTIONAL MEDICAL DOCUMENT\nDemonstration only. This is not a real medical record.\nConsultation summary: Sample primary care visit.\nFollow-up: Consult a qualified clinician for personalized care.');
  }
});

document.querySelector('#document-upload').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const input = document.querySelector('#medical-document');
  const file = input.files[0];
  if (!file) {
    showToast('Choose a document before adding it.');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('Choose a file smaller than 10 MB.');
    return;
  }
  if (session.uploadedFiles.some((name) => name === file.name)) {
    showToast('That filename is already in your demo list.');
    return;
  }
  session.uploadedFiles.push(file.name);
  const item = document.createElement('li');
  item.textContent = `${file.name} — filename added for this session only; contents were not uploaded.`;
  document.querySelector('#uploaded-files').append(item);
  input.value = '';
  showToast('Filename added. No document data was uploaded.');
});

document.querySelector('#profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const form = event.currentTarget;
  session.patient = {
    name: form.elements.name.value.trim(),
    email: form.elements.email.value.trim(),
    phone: form.elements.phone.value.trim()
  };
  updateAccount();
  document.querySelector('#profile-message').textContent = 'Profile updated for this demo session only.';
});

document.querySelectorAll('[data-doctor-panel]').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (session.doctor) selectDoctorPanel(tab.dataset.doctorPanel);
  });
});

document.querySelector('#doctor-availability-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!session.doctor) return;
  const form = event.currentTarget;
  const days = [...form.querySelectorAll('input[name="day"]:checked')].map((input) => input.value);
  if (!days.length || form.elements.start.value >= form.elements.end.value) {
    showToast('Select at least one day and a valid time range.');
    return;
  }
  session.doctorAvailability = { days, start: form.elements.start.value, end: form.elements.end.value };
  document.querySelector('#availability-message').textContent = `Sample availability saved: ${days.join(', ')}.`;
});

document.querySelector('#doctor-profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!session.doctor) return;
  const form = event.currentTarget;
  session.doctorProfile = {
    name: form.elements.name.value.trim(),
    specialty: form.elements.specialty.value.trim(),
    experience: Number(form.elements.experience.value),
    fee: Number(form.elements.fee.value),
    bio: form.elements.bio.value.trim()
  };
  session.doctor.name = session.doctorProfile.name;
  updateDoctorAccount();
  document.querySelector('#doctor-profile-message').textContent = 'Professional profile updated for this demo session only.';
});

document.querySelector('#credential-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!session.doctor) return;
  const file = event.currentTarget.elements['credential-file'].files[0];
  session.doctorCredentialStatus = `Sample details submitted${file ? ` (${file.name})` : ''}. Verification is not performed.`;
  document.querySelector('#credential-status').textContent = session.doctorCredentialStatus;
  document.querySelector('#credential-message').textContent = 'Demo submission recorded in this page only; no verification was performed.';
});

document.querySelector('#doctor-records-authorized').addEventListener('change', (event) => {
  if (!session.doctor) return;
  session.doctorRecordsAuthorized = event.currentTarget.checked;
  renderDoctorHistory();
});

document.querySelector('#clinical-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!session.doctor || !session.doctorRecordsAuthorized) {
    showToast('Authorize sample patient history before saving consultation details.');
    return;
  }
  const form = event.currentTarget;
  const action = event.submitter?.value || 'save';
  const prescription = form.elements.prescription.value.trim();
  if (action === 'prescription' && !prescription) {
    showToast('Add prescription details before issuing a demo prescription.');
    return;
  }
  session.clinicalItems.unshift({
    date: new Date().toLocaleDateString(),
    notes: form.elements.notes.value.trim(),
    prescription,
    prescriptionStatus: action === 'prescription' ? 'Demo prescription · not valid for dispensing' : (prescription ? 'Prescription draft · not issued' : ''),
    followup: form.elements.followup.value.trim()
  });
  form.reset();
  renderClinicalItems();
  document.querySelector('#clinical-message').textContent = action === 'prescription'
    ? 'Demo prescription preview created in this page session only; it is not valid for dispensing.'
    : 'Demo consultation saved in this page session only.';
  showToast(action === 'prescription'
    ? 'Demo prescription preview created. It is not a valid prescription.'
    : 'Demo consultation saved. No real record or prescription was issued.');
});

renderDoctors();
updateAccount();
