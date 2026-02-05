import * as React from 'react';
import { connect } from 'react-redux';
import { RouteComponentProps, Link } from 'react-router';
import AkAvatar from '@atlaskit/avatar';
import AkBanner from '@atlaskit/banner';
import AddIcon from '@atlaskit/icon/glyph/add';

import CreateAppModal from './CreateAppModal';
import UserDropDown from './UserDropDown';
import Logo from '../assets/Logo';

import * as styles from './PageWrapper.scss';

interface PageWrapperReduxProps {
  user: UserSubState;
  hasPendingMigration: boolean;
}
interface PageWrapperComponentProps {}

class PageWrapper extends React.PureComponent<PageWrapperReduxProps & PageWrapperComponentProps & RouteComponentProps<void, void>, {
  creatingApp: boolean,
}> {
  state = {
    creatingApp: false,
  };

  private toggleCreate = () => {
    this.setState({
      creatingApp: !this.state.creatingApp,
    });
  }

  render() {
    const isSignedIn = this.props.user.signedIn;
    const photoUrl = isSignedIn && this.props.user.user.photos && this.props.user.user.photos.length > 0
      ? this.props.user.user.photos[0].value
      : '';

    return (
      <div className={styles.pageWrapper}>
        <nav className={styles.sidebar}>
          <div className={styles.sidebarTop}>
            <Link to="/apps" className={styles.logoLink}>
              <Logo />
            </Link>
            <button className={styles.addButton} onClick={this.toggleCreate} title="Add App">
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
              <UserDropDown user={this.props.user.user} history={this.props.history} location={this.props.location}>
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
          <AkBanner appearance="error" isOpen={this.props.hasPendingMigration}>
            Your Nucleus instance has pending migrations and won't be able to create or modify releases until migrations have been run, admins can run migrations by visiting <Link to="/migrations">/migrations</Link>
          </AkBanner>
          <div style={{ display: this.props.hasPendingMigration ? 'block' : 'none', marginBottom: 16 }} />
          {this.props.children}
        </div>
        <CreateAppModal onDismiss={this.toggleCreate} isOpen={this.state.creatingApp} />
      </div>
    );
  }
}

const mapStateToProps = (state: AppState) => ({
  user: state.user,
  hasPendingMigration: state.migrations.hasPendingMigration,
});

export default connect<PageWrapperReduxProps, void, PageWrapperComponentProps>(mapStateToProps, null)(PageWrapper as any);
