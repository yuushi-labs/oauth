import { Html, Head, Body, Container, Text, Button, Preview } from '@react-email/components';

interface PasswordResetEmailProps {
  url: string;
  ip: string;
  time: string;
}

export default function PasswordResetEmail({ url, ip, time }: PasswordResetEmailProps) {
  return (
    <Html lang="ja">
      <Head />
      <Preview>パスワードリセット</Preview>
      <Body style={{ backgroundColor: '#f6f6f6', fontFamily: 'sans-serif' }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold' }}>パスワードリセットのお願い</Text>
          <Text>以下のボタンをクリックしてパスワードをリセットしてください。</Text>
          <Button href={url} style={{ backgroundColor: '#0070f3', color: '#fff', padding: '12px 24px' }}>
            リセット
          </Button>
          <Text style={{ fontSize: '12px', color: '#888' }}>
            参考: IP {ip}, {time}
          </Text>
          <Text style={{ fontSize: '12px', color: '#888' }}>
            心当たりない場合はこのメールを無視してください。
          </Text>
        </Container>
      </Body>
    </Html>
  );
}