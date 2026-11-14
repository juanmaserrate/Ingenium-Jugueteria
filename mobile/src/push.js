import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Mostrar la notificación aunque la app esté abierta.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // claves nuevas (SDK 53+) y las viejas, para funcionar en cualquier versión
    shouldShowBanner: true,
    shouldShowList: true,
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Pide permiso y devuelve el ExponentPushToken del dispositivo (o null si no se puede).
export async function registerForPush() {
  if (!Device.isDevice) return null; // los emuladores no reciben push

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('ventas', {
      name: 'Ventas',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#d82f1e',
    });
  }

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  try {
    const resp = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return resp.data; // "ExponentPushToken[...]"
  } catch {
    return null;
  }
}
