import { Html, Head, Body, Container, Text, Button, Preview } from '@react-email/components';

interface VerificationEmailProps {
  url: string;
}

export default function VerificationEmail({ url }: VerificationEmailProps) {
  return (
    <Html lang="ja">
      <Head />
      <Preview>アカウントの確認</Preview>
      <Body style={{ backgroundColor: '#f6f6f6', fontFamily: 'sans-serif' }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold' }}>アカウント確認のお願い</Text>
          <Text>以下のボタンをクリックして確認してください。</Text>
          <Button href={url} style={{ backgroundColor: '#0070f3', color: '#fff', padding: '12px 24px' }}>
            確認
          </Button>
          <Text style={{ fontSize: '12px', color: '#888' }}>
            心当たりない場合はこのメールを無視してください。
          </Text>
        </Container>
      </Body>
    </Html>
  );
}