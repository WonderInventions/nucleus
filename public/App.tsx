import * as React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { connect } from 'react-redux';

import { setBaseUpdateUrl } from './actions/base';
import { setMigrations } from './actions/migrations';
import { setUser } from './actions/user';
import PageWrapper from './components/PageWrapper';
import AppList from './components/AppList';
import AppPage from './components/AppPage';
import MigrationList from './components/MigrationList';

import AkSpinner from '@atlaskit/spinner';

import * as styles from './App.scss';

class App extends React.PureComponent<{
  user: {
    user: User,
    signedIn: boolean,
  },
  setUser: typeof setUser,
  setBaseUpdateUrl: typeof setBaseUpdateUrl,
  setMigrations: typeof setMigrations,
}, {}> {
  async componentDidMount() {
    const response = await fetch('/rest/config', { credentials: 'include' });
    const config: { user: User, app: Application, baseUpdateUrl: string, migrations: NucleusMigration[] } = await response.json();
    this.props.setBaseUpdateUrl(config.baseUpdateUrl);
    this.props.setMigrations(config.migrations);
    this.props.setUser(config.user);
    if (!config.user) {
      window.location.href = '/rest/auth/login';
    }
  }

  render() {
    if (!this.props.user || !this.props.user.signedIn) {
      return (
        <div className={styles.loader}>
          <AkSpinner size={160} />
        </div>
      );
    }

    return (
      <BrowserRouter>
        <Routes>
          <Route element={<PageWrapper />}>
            <Route index element={<Navigate to="/apps" replace />} />
            <Route path="/apps" element={<AppList />} />
            <Route path="/apps/:appSlug" element={<AppPage />} />
            <Route path="/migrations" element={<MigrationList />} />
          </Route>
        </Routes>
      </BrowserRouter>
    );
  }
}

const mapStateToProps = (state: AppState) => ({
  user: state.user,
});

const mapDispatchToProps = dispatch => ({
  setUser: user => dispatch(setUser(user)),
  setBaseUpdateUrl: url => dispatch(setBaseUpdateUrl(url)),
  setMigrations: migrations => dispatch(setMigrations(migrations)),
});

export default connect(mapStateToProps, mapDispatchToProps)(App);
