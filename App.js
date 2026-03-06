import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';

const DEFAULT_RADIUS_KM = 5;
const RADIUS_OPTIONS = [2, 5, 10, 15];

// Mock supermarket + pricing data.
// In a real app, you would fetch this from your backend that aggregates live prices.
const SUPERMARKETS = [
  {
    id: 'ah_1',
    name: 'Albert Heijn',
    chain: 'Albert Heijn',
    latitude: 52.3702,
    longitude: 4.8952,
    inventory: {
      potato: 1.49,
      milk: 1.09,
      bread: 1.99,
    },
  },
  {
    id: 'jumbo_1',
    name: 'Jumbo',
    chain: 'Jumbo',
    latitude: 52.372,
    longitude: 4.9,
    inventory: {
      potato: 1.39,
      milk: 1.05,
      bread: 1.89,
    },
  },
  {
    id: 'lidll_1',
    name: 'Lidl',
    chain: 'Lidl',
    latitude: 52.365,
    longitude: 4.92,
    inventory: {
      potato: 1.19,
      milk: 0.95,
      bread: 1.59,
    },
  },
  {
    id: 'dirk_1',
    name: 'Dirk',
    chain: 'Dirk',
    latitude: 52.375,
    longitude: 4.88,
    inventory: {
      potato: 1.29,
      milk: 0.99,
      bread: 1.69,
    },
  },
];

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export default function App() {
  const [query, setQuery] = useState('potato');
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [location, setLocation] = useState(null);
  const [locationError, setLocationError] = useState(null);
  const [loadingLocation, setLoadingLocation] = useState(true);
  const [selectedSupermarketId, setSelectedSupermarketId] = useState(null);

  useEffect(() => {
    (async () => {
      setLoadingLocation(true);
      setLocationError(null);

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocationError('Location permission is required to show nearby supermarkets.');
        setLoadingLocation(false);
        return;
      }

      const current = await Location.getCurrentPositionAsync({});
      setLocation({
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
      });
      setLoadingLocation(false);
    })();
  }, []);

  const results = useMemo(() => {
    if (!location || !query.trim()) return [];

    const lowerQuery = query.trim().toLowerCase();

    const withDistance = SUPERMARKETS.map((s) => {
      const distanceKm = haversineDistanceKm(
        location.latitude,
        location.longitude,
        s.latitude,
        s.longitude
      );
      const price = s.inventory[lowerQuery];
      return {
        ...s,
        distanceKm,
        price,
      };
    }).filter((s) => s.distanceKm <= radiusKm && s.price != null);

    return withDistance.sort((a, b) => a.price - b.price);
  }, [location, query, radiusKm]);

  const bestPrice = results.length ? results[0].price : null;

  const renderResultCard = ({ item }) => {
    const isCheapest = bestPrice != null && item.price === bestPrice;
    const isSelected = item.id === selectedSupermarketId;

    return (
      <TouchableOpacity
        style={[
          styles.card,
          isCheapest && styles.cardBest,
          isSelected && styles.cardSelected,
        ]}
        onPress={() => setSelectedSupermarketId(item.id)}
      >
        <Text style={styles.cardTitle}>{item.name}</Text>
        <Text style={styles.cardChain}>{item.chain}</Text>
        <Text style={styles.cardPrice}>€ {item.price.toFixed(2)}</Text>
        <Text style={styles.cardDistance}>{item.distanceKm.toFixed(2)} km away</Text>
        {isCheapest && <Text style={styles.badge}>Cheapest</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />

      <View style={styles.header}>
        <Text style={styles.title}>Grocery Price Finder</Text>
        <Text style={styles.subtitle}>Compare nearby supermarkets in the Netherlands</Text>
      </View>

      <View style={styles.searchSection}>
        <Text style={styles.label}>Item</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. potato"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          returnKeyType="search"
        />
      </View>

      <View style={styles.radiusSection}>
        <Text style={styles.label}>Radius</Text>
        <View style={styles.radiusChips}>
          {RADIUS_OPTIONS.map((r) => (
            <TouchableOpacity
              key={r}
              style={[styles.chip, radiusKm === r && styles.chipActive]}
              onPress={() => setRadiusKm(r)}
            >
              <Text style={[styles.chipText, radiusKm === r && styles.chipTextActive]}>
                {r} km
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.resultsHeader}>
        <Text style={styles.label}>Results</Text>
        {bestPrice != null && (
          <Text style={styles.bestPriceText}>Best price: € {bestPrice.toFixed(2)}</Text>
        )}
      </View>

      {loadingLocation ? (
        <View style={styles.center}>
          <ActivityIndicator size="small" />
          <Text style={styles.helperText}>Getting your location…</Text>
        </View>
      ) : locationError ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{locationError}</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.helperText}>
            No supermarkets with "{query}" found within {radiusKm} km.
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={renderResultCard}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F7',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    marginTop: 4,
    fontSize: 13,
    color: '#6B7280',
  },
  searchSection: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4B5563',
    marginBottom: 4,
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
    borderWidth: 1,
    fontSize: 15,
  },
  radiusSection: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  radiusChips: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
  },
  chipActive: {
    backgroundColor: '#111827',
    borderColor: '#111827',
  },
  chipText: {
    fontSize: 13,
    color: '#4B5563',
  },
  chipTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  resultsHeader: {
    paddingHorizontal: 20,
    paddingTop: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bestPriceText: {
    fontSize: 13,
    color: '#059669',
    fontWeight: '600',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  helperText: {
    marginTop: 8,
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  errorText: {
    fontSize: 13,
    color: '#B91C1C',
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
  },
  card: {
    width: 220,
    marginHorizontal: 4,
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 2,
  },
  cardBest: {
    borderWidth: 1,
    borderColor: '#059669',
  },
  cardSelected: {
    transform: [{ scale: 1.03 }],
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  cardChain: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  cardPrice: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginTop: 10,
  },
  cardDistance: {
    marginTop: 4,
    fontSize: 13,
    color: '#6B7280',
  },
  badge: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#ECFDF5',
    color: '#047857',
    fontSize: 11,
    fontWeight: '600',
  },
});

