import { Navigate, Route, Routes } from 'react-router-dom';
import { BookingsProvider } from './lib/BookingsProvider.jsx';
import Layout from './components/Layout.jsx';
import Summary from './views/Summary.jsx';
import Leaderboard from './views/Leaderboard.jsx';
import Affinity from './views/Affinity.jsx';
import Dormant from './views/Dormant.jsx';
import ClientDetail from './views/ClientDetail.jsx';

export default function App() {
  return (
    <BookingsProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/summary" replace />} />
          <Route path="summary" element={<Summary />} />
          <Route path="leaderboard" element={<Leaderboard />} />
          <Route path="affinity" element={<Affinity />} />
          <Route path="dormant" element={<Dormant />} />
          <Route path="client/:clientKey" element={<ClientDetail />} />
          <Route path="*" element={<Navigate to="/summary" replace />} />
        </Route>
      </Routes>
    </BookingsProvider>
  );
}
