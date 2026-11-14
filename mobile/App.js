import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import SalesScreen from './src/screens/SalesScreen';
import { loadSession, saveSession, clearSession } from './src/storage';
import { registerForPush } from './src/push';
import { registerPush } from './src/api';
import { COLORS } from './src/config';

export default function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState({ screen: 'dash' });
  const notifSub = useRef(null);

  useEffect(() => {
    loadSession().then((s) => {
      if (s && s.token) { setSession(s); syncPush(s); }
      setBooting(false);
    });
    // Toca una notificación → por ahora sólo la dejamos registrada; la app abre en el panel.
    notifSub.current = Notifications.addNotificationResponseReceivedListener(() => {});
    return () => { if (notifSub.current) notifSub.current.remove(); };
  }, []);

  const syncPush = async (s) => {
    try {
      const pushToken = await registerForPush();
      if (pushToken) await registerPush(s.token, pushToken);
    } catch { /* no fatal */ }
  };

  const handleLogin = async (res) => {
    const s = { token: res.token, user: res.user };
    await saveSession(s);
    setSession(s);
    syncPush(s);
  };

  const handleLogout = async () => {
    await clearSession();
    setView({ screen: 'dash' });
    setSession(null);
  };

  if (booting) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.bg }}>
        <ActivityIndicator size="large" color={COLORS.red} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {!session ? (
        <LoginScreen onLogin={handleLogin} />
      ) : view.screen === 'sales' ? (
        <SalesScreen
          session={session}
          branchId={view.branchId}
          name={view.name}
          onBack={() => setView({ screen: 'dash' })}
        />
      ) : (
        <DashboardScreen
          session={session}
          onLogout={handleLogout}
          onOpenSales={(branchId, name) => setView({ screen: 'sales', branchId, name })}
        />
      )}
    </>
  );
}
