from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
import uuid

db = SQLAlchemy()

def generate_uuid():
    return str(uuid.uuid4())

class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.String(36), primary_key=True, default=generate_uuid)
    github_id = db.Column(db.Integer, unique=True, nullable=True)
    username = db.Column(db.String(100), nullable=False)
    avatar_url = db.Column(db.String(255))
    access_token = db.Column(db.String(255), nullable=True)
    email = db.Column(db.String(254), unique=True, nullable=True)
    password_hash = db.Column(db.String(128), nullable=True)
    name = db.Column(db.String(100), nullable=True)
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    projects = db.relationship('Project', backref='owner', lazy=True)

class Team(db.Model):
    __tablename__ = 'teams'
    id         = db.Column(db.String(36), primary_key=True, default=generate_uuid)
    name       = db.Column(db.String(100), nullable=False)
    created_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    members    = db.relationship('TeamMember', backref='team', cascade='all, delete-orphan')
    projects   = db.relationship('Project', backref='team')

class TeamMember(db.Model):
    __tablename__ = 'team_members'
    id        = db.Column(db.String(36), primary_key=True, default=generate_uuid)
    team_id   = db.Column(db.String(36), db.ForeignKey('teams.id'), nullable=False)
    user_id   = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    role      = db.Column(db.String(20), default='member')  # 'admin' | 'member'
    joined_at = db.Column(db.DateTime, default=datetime.utcnow)
    __table_args__ = (db.UniqueConstraint('team_id', 'user_id'),)

class Project(db.Model):
    __tablename__ = 'projects'
    id = db.Column(db.String(36), primary_key=True, default=generate_uuid)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    team_id = db.Column(db.String(36), db.ForeignKey('teams.id'), nullable=True)
    name = db.Column(db.String(100), nullable=False)
    repo_url = db.Column(db.String(255), nullable=False)
    port = db.Column(db.Integer, unique=True, nullable=False)
    status = db.Column(db.String(50), default='stopped') # running, stopped, errored, building
    container_id = db.Column(db.String(100))
    dockerfile_path = db.Column(db.String(256), nullable=False, default='Dockerfile')
    internal_port = db.Column(db.Integer, default=5000)
    env_vars = db.Column(db.Text, default='{}')
    is_compose = db.Column(db.Boolean, default=False)
    compose_ports = db.Column(db.Text, default='[]')  # JSON list of {service, host_port, container_port}
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    builds = db.relationship('Build', backref='project', lazy=True, cascade='all, delete-orphan')

class Build(db.Model):
    __tablename__ = 'builds'
    id = db.Column(db.String(36), primary_key=True, default=generate_uuid)
    project_id = db.Column(db.String(36), db.ForeignKey('projects.id'), nullable=False)
    status = db.Column(db.String(50), default='building') # building, success, failed
    logs = db.Column(db.Text, default='')
    started_at = db.Column(db.DateTime, default=datetime.utcnow)
    finished_at = db.Column(db.DateTime)

class Session(db.Model):
    __tablename__ = 'sessions'
    id = db.Column(db.String(36), primary_key=True, default=generate_uuid)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    token = db.Column(db.String(100), unique=True, nullable=False, default=lambda: str(uuid.uuid4()))
    expires_at = db.Column(db.DateTime, nullable=False)
