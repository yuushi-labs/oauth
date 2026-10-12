import { Html, Head, Body, Container, Text, Preview } from '@react-email/components';

export default function AccountDeletionEmail() {
  return (
    <Html lang="ja">
      <Head />
      <Preview>アカウント削除のお知らせ</Preview>
      <Body style={{ backgroundColor: '#f6f6f6', fontFamily: 'sans-serif' }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold' }}>アカウント削除のお知らせ</Text>
          <Text>アカウントは削除されます。</Text>
          <Text>30日間保持後、完全に削除されます。</Text>
        </Container>
      </Body>
    </Html>
  );
}