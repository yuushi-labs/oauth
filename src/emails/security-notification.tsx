import { Html, Head, Body, Container, Text, Preview } from '@react-email/components';

interface SecurityNotificationEmailProps {
  device: string;
  ip: string;
  time: string;
}

export default function SecurityNotificationEmail({ device, ip, time }: SecurityNotificationEmailProps) {
  return (
    <Html lang="ja">
      <Head />
      <Preview>セキュリティ通知</Preview>
      <Body style={{ backgroundColor: '#f6f6f6', fontFamily: 'sans-serif' }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold' }}>セキュリティ通知</Text>
          <Text>新しいログインがあります。</Text>
          <Text>デバイス: {device}</Text>
          <Text>IP: {ip}</Text>
          <Text>時刻: {time}</Text>
        </Container>
      </Body>
    </Html>
  );
}