// Page side: the React components and the client they share.
export {
  Mailbox, type MailboxProps, SoshialProvider, ConversationList, ThreadPane, NewButtons, NewMessage, NewGroup, NewChannel, NewThing,
  useThreads, type MailView,
} from './Mailbox';
export { MessagesPage, type MessagesPageProps } from './MessagesPage';
export { MailboxButton, type MailboxButtonProps, type NotificationTab } from './MailboxButton';
export { ClassMessages, type ClassMessagesProps } from './ClassMessages';
export { createClient, type SoshialClient, type Result } from '../client';
