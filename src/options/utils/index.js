import Modal from 'vueleton/lib/modal/bundle';
import { route } from '#/common/router';
import Message from '../views/message';

export const store = {
  route,
};

export function showMessage(message) {
  const modal = Modal.show(h => h(Message, {
    props: { message },
    on: {
      dismiss() {
        modal.close();
      },
    },
  }), {
    transition: 'in-out',
  });
  if (message.buttons) {
    // TODO: implement proper keyboard navigation, autofocus, and Enter/Esc in Modal module
    document.querySelector('.vl-modal button').focus();
  } else {
    setTimeout(() => {
      modal.close();
    }, 2000);
  }
}
