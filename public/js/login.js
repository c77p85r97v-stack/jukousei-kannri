// ログイン画面
(async () => {
  const { api, $, $$, h } = koshu;
  const show = id => {
    for (const s of ['choose', 'gaBox', 'adminBox', 'setupBox']) $('#' + s).hidden = s !== id;
  };
  try {
    const setup = await api.get('/api/admin/setup');
    if (setup.needed) {
      show('setupBox');
      $('#setupForm').addEventListener('submit', async e => {
        e.preventDefault();
        $('#setupError').textContent = '';
        try {
          await api.post('/api/admin/setup', { token: $('#setupToken').value, name: $('#setupName').value, pin: $('#setupPin').value });
          location.href = '/admin.html';
        } catch (err) {
          $('#setupError').textContent = err.message;
        }
      });
      return;
    }
    const boot = await api.get('/api/bootstrap');
    const gas = boot.staff.filter(s => s.role === 'ga');
    const admins = boot.staff.filter(s => s.role === 'admin');
    $('#gaEmpty').hidden = gas.length > 0;
    $('#gaNames').append(
      ...gas.map(s =>
        h('button', {
          type: 'button',
          onclick: async () => {
            try {
              await api.post('/api/login', { staffId: s.id });
              location.href = '/ga.html';
            } catch (err) {
              $('#pageError').textContent = err.message;
            }
          },
        }, s.name),
      ),
    );
    $('#adminName').append(...admins.map(s => h('option', { value: s.id }, s.name)));
    $('#asGa').addEventListener('click', () => show('gaBox'));
    $('#asAdmin').addEventListener('click', () => {
      show('adminBox');
      $('#adminPin').focus();
    });
    for (const b of $$('.back')) b.addEventListener('click', () => show('choose'));
    $('#adminForm').addEventListener('submit', async e => {
      e.preventDefault();
      $('#adminError').textContent = '';
      try {
        await api.post('/api/admin/login', { staffId: Number($('#adminName').value), pin: $('#adminPin').value });
        location.href = '/admin.html';
      } catch (err) {
        $('#adminError').textContent = err.message;
        $('#adminPin').select();
      }
    });
  } catch (err) {
    $('#pageError').textContent = err.message;
  }
})();
