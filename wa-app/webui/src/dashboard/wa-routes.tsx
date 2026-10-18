import { createBrowserRouter } from 'react-router';
import { WaAccountInfoRoute, WaCreateAccountRoute, WaHomeRoute, WaInboxRoute, WaLayout, WaNotFoundRoute } from './wa-page';

export const waRouter = createBrowserRouter([
  {
    path: '/',
    Component: WaLayout,
    children: [
      { index: true, Component: WaHomeRoute },
      { path: 'accounts/new', Component: WaCreateAccountRoute },
      {
        path: 'accounts/:accountID',
        children: [
          { index: true, Component: WaAccountInfoRoute },
          { path: 'chats', Component: WaInboxRoute },
          { path: 'chats/:contactID', Component: WaInboxRoute },
        ],
      },
      { path: '*', Component: WaNotFoundRoute },
    ],
  },
]);
