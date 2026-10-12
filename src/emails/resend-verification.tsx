import { Html, Head, Body, Container, Text, Button, Preview } from '@react-email/components';

interface ResendVerificationEmailProps {
  url: string;
}

export default function ResendVerificationEmail({ url }: ResendVerificationEmailProps) {
  return (
    <Html lang="ja">
      <Head />
      <Preview>確認メールの再送信</Preview>
      <Body style={{ backgroundColor: '#f6f6f6', fontFamily: 'sans-serif' }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold' }}>確認メールの再送信</Text>
          <Text>以下のボタンをクリックして確認してください。</Text>
          <Button href={url} style={{ backgroundColor: '#0070f3', color: '#fff', padding: '12px 24px' }}>
            確認
          </Button>
          <Text style={{ fontSize: '12px', color: '#888' }}>
            以前の確認URLは無効化されています。
          </Text>
        </Container>
      </Body>
    </Html>
  );
}