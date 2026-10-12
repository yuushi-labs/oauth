import { Html, Head, Body, Container, Text, Preview } from '@react-email/components';

interface ChangeNotificationEmailProps {
  change: string;
  time: string;
  ip: string;
}

export default function ChangeNotificationEmail({ change, time, ip }: ChangeNotificationEmailProps) {
  return (
    <Html lang="ja">
      <Head />
      <Preview>アカウント変更通知</Preview>
      <Body style={{ backgroundColor: '#f6f6f6', fontFamily: 'sans-serif' }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold' }}>アカウント変更通知</Text>
          <Text>アカウントが変更されました。</Text>
          <Text>変更内容: {change}</Text>
          <Text>時刻: {time}</Text>
          <Text>IP: {ip}</Text>
          <Text style={{ fontSize: '12px', color: '#888' }}>
            心当たりない場合はパスワードリセットをお願いします。
          </Text>
        </Container>
      </Body>
    </Html>
  );
}