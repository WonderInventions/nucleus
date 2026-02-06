import * as React from 'react';
import { useSelector } from 'react-redux';
import { Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import AkAvatar from '@atlaskit/avatar';
import AkBanner from '@atlaskit/banner';
import AddIcon from '@atlaskit/icon/glyph/add';

import CreateAppModal from './CreateAppModal';
import UserDropDown from './UserDropDown';
import Logo from '../assets/Logo';

import styles from './PageWrapper.scss';

function PageWrapper() {
  const [creatingApp, setCreatingApp] = React.useState(false);
  const user = useSelector((state: AppState) => state.user);
  const hasPendingMigration = useSelector((state: AppState) => state.migrations.hasPendingMigration);
  const navigate = useNavigate();
  const location = useLocation();

  const toggleCreate = () => setCreatingApp(prev => !prev);
  const isSignedIn = user.signedIn;
  const photoUrl = isSignedIn && user.user.photos && user.user.photos.length > 0
    ? user.user.photos[0].value
    : '';
  const history = React.useMemo(() => ({ push: (path: string) => navigate(path) }), [navigate]);

  return (
    <div className={styles.pageWrapper}>
      <nav className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <Link to="/apps" className={styles.logoLink}>
            <Logo />
          </Link>
          <button className={styles.addButton} onClick={toggleCreate} title="Add App">
            <AddIcon label="Add App" />
          </button>
        </div>
        <div className={styles.sidebarContent}>
          <div className={styles.sidebarTitle}>
            <div className={styles.titleText}>Applications</div>
            <div className={styles.subtitleText}>Powered by Nucleus</div>
          </div>
          <div className={styles.navGroup}>
            <div className={styles.navGroupTitle}>My Apps</div>
            <Link to="/apps" className={styles.navItem}>View</Link>
          </div>
        </div>
        <div className={styles.sidebarBottom}>
          {isSignedIn ? (
            <UserDropDown user={user.user} history={history} location={location}>
              <div className={styles.avatarButton}>
                <AkAvatar size="small" src={photoUrl} />
              </div>
            </UserDropDown>
          ) : (
            <a href="/rest/auth/login" className={styles.avatarButton}>
              <AkAvatar size="small" />
            </a>
          )}
        </div>
      </nav>
      <div className={styles.pageContainer}>
        <AkBanner appearance="error" isOpen={hasPendingMigration}>
          Your Nucleus instance has pending migrations and won't be able to create or modify releases until migrations have been run, admins can run migrations by visiting <Link to="/migrations">/migrations</Link>
        </AkBanner>
        <div style={{ display: hasPendingMigration ? 'block' : 'none', marginBottom: 16 }} />
        <Outlet />
      </div>
      <CreateAppModal onDismiss={toggleCreate} isOpen={creatingApp} />
    </div>
  );
}

export default PageWrapper;
